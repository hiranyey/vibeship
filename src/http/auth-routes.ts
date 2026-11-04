import { timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import { systemContext } from '../actor.ts';
import type { OidcClient, LoginAttempt } from '../auth/oidc.ts';
import type { Config } from '../config.ts';
import type { Services } from '../services/index.ts';
import { CSP, ICON_LINKS } from '../ui/view.ts';
import { type AppEnv, cookieSettings } from './auth.ts';

const LOGIN_TTL_S = 10 * 60;
const LOGIN_CONTEXT = 'oidc-login';

type PendingLogin = LoginAttempt & { returnTo: string; exp: number };

/** Only paths on Vibeship itself, so the login can't be used as an open redirect. */
export function safeReturnTo(value: string | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : '/';
}

/** A small standalone page in the app's style: a centred card, no navigation. */
function page(c: Context<AppEnv>, opts: { title: string; host: string; status?: 200 | 400 | 403 | 502 | 503 }, body: unknown) {
  c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
  return c.html(html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${opts.title} · Vibeship</title>
        ${raw(ICON_LINKS)}
        <link rel="stylesheet" href="/static/vibeship.css" />
      </head>
      <body class="auth-page">
        <main class="card card-pad auth-card">
          <div class="topbar-brand">
            <img class="brand-mark" src="/static/vibeship-mark.svg" alt="" width="28" height="28" />
            <div>
              <div class="brand-title">Vibeship</div>
            </div>
          </div>
          <h1 class="auth-title">${opts.title}</h1>
          ${body}
        </main>
      </body>
    </html>`, opts.status ?? 200);
}

/**
 * `/auth/login` (a page with a button), `/auth/start`, `/auth/callback` and `/auth/logout`: OIDC authorization code
 * with PKCE. What the callback must check (state, nonce, PKCE verifier) rides
 * in a short-lived cookie sealed with the master key, so nothing is stored
 * server side until the login succeeds.
 */
export function authRoutes(deps: { config: Config; services: Services; oidc: OidcClient | null }): Hono<AppEnv> {
  const { config, services, oidc } = deps;
  const cookies = cookieSettings(config);
  const app = new Hono<AppEnv>();
  const host = new URL(config.publicUrl).host;
  const notConfigured = (c: Context<AppEnv>) =>
    page(c, { title: 'Login is not configured', host, status: 503 }, html`<p class="text-muted">Set <code class="inline">OIDC_ISSUER</code>, <code class="inline">OIDC_CLIENT_ID</code> and <code class="inline">OIDC_CLIENT_SECRET</code>. API tokens still work.</p>`);

  // Where the UI sends anyone not logged in. Nothing happens until they press the button.
  app.get('/login', (c) => {
    const returnTo = safeReturnTo(c.req.query('returnTo'));
    if (c.get('principal')?.kind === 'user') return c.redirect(returnTo, 302);
    if (!oidc) return notConfigured(c);
    const start = returnTo === '/' ? '/auth/start' : `/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
    return page(c, { title: 'Log in', host }, html`
      <p class="text-muted mt-0">Sign in with your identity provider to manage projects and deploys.</p>
      <a class="btn btn-primary btn-lg auth-button" href="${start}">Log in with SSO</a>`);
  });

  app.get('/start', async (c) => {
    if (!oidc) return notConfigured(c);
    const { url, attempt } = await oidc.start();
    const pending: PendingLogin = { ...attempt, returnTo: safeReturnTo(c.req.query('returnTo')), exp: Date.now() + LOGIN_TTL_S * 1000 };
    setCookie(c, cookies.login, services.box.seal(JSON.stringify(pending), LOGIN_CONTEXT), {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: LOGIN_TTL_S,
    });
    return c.redirect(url, 302);
  });

  app.get('/callback', async (c) => {
    const failed = (why: string, status: 400 | 502 = 400) =>
      page(c, { title: 'Login failed', host, status }, html`<p class="text-muted mt-0">${why}</p><a class="btn btn-primary auth-button" href="/auth/login">Try again</a>`);

    const sealed = getCookie(c, cookies.login);
    deleteCookie(c, cookies.login, { path: '/', secure: cookies.secure });
    if (!oidc) return failed('Login is not configured.');

    const error = c.req.query('error');
    if (error) return failed(`The identity provider said: ${c.req.query('error_description') ?? error}`);

    let pending: PendingLogin;
    try {
      pending = JSON.parse(services.box.open(sealed ?? '', LOGIN_CONTEXT)) as PendingLogin;
    } catch {
      return failed('This login has no matching start, or it was started in another browser.');
    }
    const state = c.req.query('state') ?? '';
    if (pending.exp < Date.now()) return failed('This login took too long.');
    if (state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
      return failed('The login state does not match.');
    }
    const code = c.req.query('code');
    if (!code) return failed('The identity provider sent no code.');

    let identity;
    try {
      identity = await oidc.finish(code, pending);
    } catch (err) {
      console.error('OIDC login failed', err);
      return failed(`Could not complete the login: ${(err as Error).message}`, 502);
    }

    if (config.adminEmails.length > 0 && !(identity.emailVerified && config.adminEmails.includes(identity.email.toLowerCase()))) {
      services.audit.record({ ...systemContext, ip: c.get('ip') }, 'auth.refused', null, {
        sub: identity.sub, email: identity.email, emailVerified: identity.emailVerified ?? false,
      });
      return page(c, { title: 'Not allowed', host, status: 403 }, html`<p class="text-muted mt-0">${identity.email || 'This account'} may not log in to this Vibeship${
        identity.email && !identity.emailVerified ? ' (its email is not verified)' : ''
      }.</p><a class="btn btn-secondary auth-button" href="/auth/login">Use another account</a>`);
    }

    const { token, expiresAt } = services.sessions.login(identity, { ip: c.get('ip'), userAgent: c.req.header('user-agent') });
    setCookie(c, cookies.session, token, {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: 'Lax',
      path: '/',
      expires: expiresAt,
    });
    return c.redirect(pending.returnTo, 302);
  });

  // GET only shows a button: logging out changes state, so it takes a same-origin POST.
  app.get('/logout', (c) =>
    page(c, { title: 'Log out', host }, html`<form method="post" action="/auth/logout"><button class="btn btn-primary auth-button" type="submit">Log out</button></form>`),
  );

  app.post('/logout', (c) => {
    const token = getCookie(c, cookies.session);
    const p = c.get('principal');
    if (token && p?.kind === 'user') services.sessions.logout(p.ctx, token);
    deleteCookie(c, cookies.session, { path: '/', secure: cookies.secure });
    return c.redirect('/auth/login', 303);
  });

  return app;
}
