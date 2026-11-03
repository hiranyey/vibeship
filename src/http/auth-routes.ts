import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { OidcClient, LoginAttempt } from '../auth/oidc.ts';
import type { Config } from '../config.ts';
import type { Services } from '../services/index.ts';
import { type AppEnv, cookieSettings } from './auth.ts';

const LOGIN_TTL_S = 10 * 60;
const LOGIN_CONTEXT = 'oidc-login';

type PendingLogin = LoginAttempt & { returnTo: string; exp: number };

/** Only paths on Vibeship itself, so the login can't be used as an open redirect. */
export function safeReturnTo(value: string | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : '/';
}

function page(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Vibeship</title>
      </head>
      <body style="font-family: system-ui, sans-serif; margin: 2rem">
        <h1>${title}</h1>
        ${body}
      </body>
    </html>`;
}

/**
 * `/auth/login`, `/auth/callback` and `/auth/logout`: OIDC authorization code
 * with PKCE. What the callback must check (state, nonce, PKCE verifier) rides
 * in a short-lived cookie sealed with the master key, so nothing is stored
 * server side until the login succeeds.
 */
export function authRoutes(deps: { config: Config; services: Services; oidc: OidcClient | null }): Hono<AppEnv> {
  const { config, services, oidc } = deps;
  const cookies = cookieSettings(config);
  const app = new Hono<AppEnv>();

  app.get('/login', async (c) => {
    if (!oidc) {
      return c.html(page('Login is not configured', html`<p>Set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code> and <code>OIDC_CLIENT_SECRET</code>. API tokens still work.</p>`), 503);
    }
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
      c.html(page('Login failed', html`<p>${why}</p><p><a href="/auth/login">Try again</a></p>`), status);

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
    c.html(page('Log out', html`<form method="post" action="/auth/logout"><button type="submit">Log out</button></form>`)),
  );

  app.post('/logout', (c) => {
    const token = getCookie(c, cookies.session);
    const p = c.get('principal');
    if (token && p?.kind === 'user') services.sessions.logout(p.ctx, token);
    deleteCookie(c, cookies.session, { path: '/', secure: cookies.secure });
    return c.redirect('/', 303);
  });

  return app;
}
