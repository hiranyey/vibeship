import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/auth.ts';
import type { Services } from '../services/index.ts';
import { adminPages } from './admin.ts';
import { type Loaded, readAsset, STATIC } from './assets.ts';
import { projectPages } from './projects.ts';
import { View } from './view.ts';

/** The paths the UI owns; everything else (`/api`, `/mcp`, `/hooks`, `/auth`) answers in its own format. */
export const UI_PATHS = ['/', '/projects', '/projects/*', '/deploys/*', '/settings', '/settings/*'];

export function isUiPath(path: string): boolean {
  return !/^\/(api|mcp|hooks|auth|static|healthz)(\/|$)/.test(path);
}

const brand = (file: string) => new URL(`../../brand/${file}`, import.meta.url);
const font = (file: string) => ({ file: new URL(`../../fonts/${file}`, import.meta.url), type: 'font/woff2' });

/** Self-hosted web fonts from `fonts/`, referenced by `vibeship.css` as `fonts/<file>`. */
const FONTS: Record<string, { file: URL; type: string }> = Object.fromEntries(
  ['newsreader', 'source-serif-4', 'jetbrains-mono'].flatMap((name) =>
    ['latin', 'latin-ext'].map((subset) => [`${name}-${subset}.woff2`, font(`${name}-${subset}.woff2`)]),
  ),
);

/** Icons browsers and the web manifest ask for at the site root, from `brand/`. */
const ROOT_ICONS: Record<string, { file: URL; type: string }> = {
  'favicon.ico': { file: brand('favicon.ico'), type: 'image/x-icon' },
  'favicon.svg': { file: brand('favicon.svg'), type: 'image/svg+xml' },
  'favicon-16.png': { file: brand('favicon-16.png'), type: 'image/png' },
  'favicon-32.png': { file: brand('favicon-32.png'), type: 'image/png' },
  'apple-touch-icon.png': { file: brand('apple-touch-icon.png'), type: 'image/png' },
  'icon-192.png': { file: brand('icon-192.png'), type: 'image/png' },
  'icon-512.png': { file: brand('icon-512.png'), type: 'image/png' },
  'icon-512-maskable.png': { file: brand('icon-512-maskable.png'), type: 'image/png' },
  'site.webmanifest': { file: brand('site.webmanifest'), type: 'application/manifest+json' },
};

/**
 * The web UI: pages rendered on the server, forms that post back and
 * redirect, and live logs streamed from the API by `/static/ui.js`. Only a
 * logged-in user gets in; API tokens are for `/api` and `/mcp`.
 */
export function uiRoutes(deps: { config: Config; services: Services }): { app: Hono<AppEnv>; view: View } {
  const view = new View(deps.config);
  const app = new Hono<AppEnv>();

  const send = (c: Context<AppEnv>, asset: Loaded | undefined) => {
    if (!asset) throw new AppError('not_found', 'Not found');
    c.header('Content-Type', asset.type);
    // A URL carrying the current version never changes; anything else is checked every time.
    c.header('Cache-Control', c.req.query('v') === asset.version ? 'public, max-age=31536000, immutable' : 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(asset.body));
  };
  app.get('/static/:file', (c) => send(c, readAsset(c.req.param('file'), STATIC)));
  app.get('/static/fonts/:file', (c) => send(c, readAsset(c.req.param('file'), FONTS)));
  for (const name of Object.keys(ROOT_ICONS)) app.get(`/${name}`, (c) => send(c, readAsset(name, ROOT_ICONS)));

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
