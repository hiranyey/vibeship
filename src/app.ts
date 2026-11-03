import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { HttpOidcClient, type OidcClient } from './auth/oidc.ts';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { AppError } from './errors.ts';
import { apiRoutes } from './http/api.ts';
import { type AppEnv, authenticate, clientIp } from './http/auth.ts';
import { authRoutes } from './http/auth-routes.ts';
import { hookRoutes } from './http/hooks.ts';
import { mcpRoute } from './mcp/route.ts';
import type { Services } from './services/index.ts';

export type AppDeps = {
  config: Config;
  db: Db;
  services: Services;
  /** A fake for tests; by default built from `config.oidc`, or null when login isn't configured. */
  oidc?: OidcClient | null;
};

const tooLarge = () => {
  throw new AppError('validation', 'The request body is too large');
};

/**
 * Every route except `/healthz` and the webhook (whose URL is its secret)
 * needs a session or an API token. Apps on the `web` network can reach
 * Vibeship directly without going through Caddy, so nothing relies on Caddy
 * to keep anyone out.
 */
export function createApp({ config, db, services, oidc }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const login = oidc !== undefined ? oidc : config.oidc ? new HttpOidcClient(config.oidc) : null;

  app.get('/healthz', (c) => {
    db.get('SELECT 1');
    return c.json({ ok: true });
  });

  const auth = authenticate(config, services);
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/hooks/')) {
      c.set('ip', clientIp(c));
      c.set('principal', null);
      return next();
    }
    return auth(c, next);
  });

  app.use('/hooks/*', bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }));
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
  app.all('/mcp', mcpRoute(services));
  app.route('/hooks', hookRoutes({ services }));
  app.route('/auth', authRoutes({ config, services, oidc: login }));
  app.route('/api', apiRoutes({ config, services }));

  // Placeholder until the web UI lands in phase 6.
  app.get('/', (c) => {
    const p = c.get('principal');
    if (!p) return c.redirect('/auth/login', 302);
    const who = p.kind === 'user' ? p.user.email || p.user.oidcSub : `token ${p.token.name}`;
    return c.html(html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Vibeship</title>
        </head>
        <body style="font-family: system-ui, sans-serif; margin: 2rem">
          <h1>Vibeship</h1>
          <p>Running on <code>${config.publicUrl}</code> with base domain <code>${config.baseDomain}</code>.</p>
          <p>Logged in as ${who}.</p>
          <form method="post" action="/auth/logout"><button type="submit">Log out</button></form>
        </body>
      </html>`);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.code === 'unauthorized') c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  return app;
}
