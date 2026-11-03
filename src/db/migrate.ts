import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';

export const defaultMigrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

type Migration = { version: number; name: string; sql: string };

function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const match = /^(\d+)_([\w-]+)\.sql$/.exec(file);
    if (!match) throw new Error(`Migration file name must look like 001_name.sql: ${file}`);
    migrations.push({ version: Number(match[1]), name: match[2]!, sql: readFileSync(join(dir, file), 'utf8') });
  }
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1, 2, 3... without gaps; found ${m.version} at position ${i + 1}`);
  });
  return migrations;
}

/** Applies every migration newer than the database, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, dir: string = defaultMigrationsDir): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const current = db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
  const migrations = loadMigrations(dir);
  if (current > migrations.length) {
    throw new Error(`Database is at migration ${current} but this build only knows ${migrations.length}; refusing to start an older build`);
  }

  const applied: number[] = [];
  for (const m of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', m.version, m.name);
    });
    applied.push(m.version);
  }
  return applied;
}
