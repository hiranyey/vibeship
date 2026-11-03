import { Hono } from 'hono';
import { html } from 'hono/html';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { AppError } from './errors.ts';
import type { Services } from './services/index.ts';

export type AppDeps = {
  config: Config;
  db: Db;
  services: Services;
};

export function createApp({ config, db }: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => {
    db.get('SELECT 1');
    return c.json({ ok: true });
  });

  // Placeholder until the web UI lands in phase 6.
  app.get('/', (c) =>
    c.html(html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Vibeship</title>
        </head>
        <body style="font-family: system-ui, sans-serif; margin: 2rem">
          <h1>Vibeship</h1>
          <p>Running on <code>${config.publicUrl}</code> with base domain <code>${config.baseDomain}</code>.</p>
        </body>
      </html>`),
  );

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  return app;
}
