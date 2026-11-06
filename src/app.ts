import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HttpOidcClient, type OidcClient } from './auth/oidc.ts';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { AppError } from './errors.ts';
import { apiRoutes } from './http/api.ts';
import { type AppEnv, authenticate } from './http/auth.ts';
import { clientIp, TrustedProxies } from './http/client-ip.ts';
import { authRoutes } from './http/auth-routes.ts';
import { hookRoutes, WEBHOOK_BODY_LIMIT_BYTES } from './http/hooks.ts';
import { mcpRoute } from './mcp/route.ts';
import type { Services } from './services/index.ts';
import { isUiPath, uiError, uiRoutes } from './ui/index.ts';

export type AppDeps = {
  config: Config;
  db: Db;
  services: Services;
  /** A fake for tests; by default built from `config.oidc`, or null when login isn't configured. */
  oidc?: OidcClient | null;
  /** Who may name the client in X-Real-Ip; by default the IPs in `config.trustedProxies` (server.ts also resolves the hostnames). */
  proxies?: TrustedProxies;
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
export function createApp({ config, db, services, oidc, proxies = new TrustedProxies(config.trustedProxies) }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const login = oidc !== undefined ? oidc : config.oidc ? new HttpOidcClient(config.oidc) : null;

  app.get('/healthz', (c) => {
    db.get('SELECT 1');
    return c.json({ ok: true });
  });

  const auth = authenticate(config, services, proxies);
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/hooks/')) {
      c.set('ip', clientIp(c, proxies));
      c.set('principal', null);
      return next();
    }
    return auth(c, next);
  });

  app.use('/hooks/*', bodyLimit({ maxSize: WEBHOOK_BODY_LIMIT_BYTES, onError: tooLarge }));
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
  app.all('/mcp', mcpRoute(services, { publicUrl: config.publicUrl, baseDomain: config.baseDomain }));
  app.route('/hooks', hookRoutes({ services }));
  app.route('/auth', authRoutes({ config, services, oidc: login }));
  app.route('/api', apiRoutes({ config, services }));

  const ui = uiRoutes({ config, services });
  app.route('/', ui.app);

  app.notFound((c) => {
    if (isUiPath(c.req.path) && c.get('principal')?.kind === 'user') return ui.view.error(c, 404, 'Not found', 'There is no page here.');
    return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });

  app.onError((err, c) => {
    if (err instanceof AppError && isUiPath(c.req.path)) return uiError(ui.view, c, err);
    if (err instanceof AppError) {
      if (err.code === 'unauthorized') c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  return app;
}
