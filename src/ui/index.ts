import { readFileSync } from 'node:fs';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/auth.ts';
import type { Services } from '../services/index.ts';
import { adminPages } from './admin.ts';
import { projectPages } from './projects.ts';
import { View } from './view.ts';

/** The paths the UI owns; everything else (`/api`, `/mcp`, `/hooks`, `/auth`) answers in its own format. */
export const UI_PATHS = ['/', '/projects', '/projects/*', '/deploys/*', '/settings', '/settings/*'];

export function isUiPath(path: string): boolean {
  return !/^\/(api|mcp|hooks|auth|static|healthz)(\/|$)/.test(path);
}

const STATIC: Record<string, { file: URL; type: string }> = {
  'vibeship.css': { file: new URL('../../vibeship.css', import.meta.url), type: 'text/css; charset=utf-8' },
  'ui.js': { file: new URL('./static/ui.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
};

/**
 * The web UI: pages rendered on the server, forms that post back and
 * redirect, and live logs streamed from the API by `/static/ui.js`. Only a
 * logged-in user gets in; API tokens are for `/api` and `/mcp`.
 */
export function uiRoutes(deps: { config: Config; services: Services }): { app: Hono<AppEnv>; view: View } {
  const view = new View(deps.config);
  const app = new Hono<AppEnv>();

  // Read once at startup; in development node --watch restarts on changes to src/.
  const assets = Object.fromEntries(Object.entries(STATIC).map(([name, { file, type }]) => [name, { body: readFileSync(file), type }]));
  app.get('/static/:file', (c) => {
    const asset = assets[c.req.param('file')];
    if (!asset) throw new AppError('not_found', 'Not found');
    c.header('Content-Type', asset.type);
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(asset.body);
  });

  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const p = c.get('principal');
    if (p?.kind === 'user') return next();
    if (p?.kind === 'token') throw new AppError('forbidden', 'The web UI needs a login; API tokens work with /api and /mcp.');
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      const url = new URL(c.req.url);
      const back = url.pathname + url.search;
      return c.redirect(back === '/' ? '/auth/login' : `/auth/login?returnTo=${encodeURIComponent(back)}`, 302);
    }
    throw new AppError('unauthorized', 'Your session has expired; log in again.');
  };
  const limit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: () => {
      throw new AppError('validation', 'The form is too large');
    },
  });
  for (const path of UI_PATHS) app.use(path, guard, limit);

  app.route('/', projectPages({ ...deps, view }));
  app.route('/', adminPages({ services: deps.services, view }));
  return { app, view };
}

/** An HTML error page for UI paths, so a missing project or an expired session isn't a JSON blob. */
export function uiError(view: View, c: Context<AppEnv>, err: AppError): Response | Promise<Response> {
  // A form posted after the session expired: send them to log in again.
  if (err.code === 'unauthorized') return c.redirect('/auth/login', 303);
  const titles: Record<string, string> = {
    not_found: 'Not found', forbidden: 'Not allowed', conflict: 'Conflict', validation: 'Invalid request', unavailable: 'Unavailable',
  };
  const status = err.status === 401 ? 403 : err.status;
  return view.error(c, status, titles[err.code] ?? 'Error', err.message);
}
