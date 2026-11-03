import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { createServices } from './services/index.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const db = new Db(config.dbPath);
const applied = migrate(db);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);

const services = createServices({ db, config });
const app = createApp({ config, db, services });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Vibeship listening on :${info.port}, public URL ${config.publicUrl}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
