import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { tempDir } from './helpers.ts';

function scratch() {
  const db = new Db(':memory:');
  db.exec('CREATE TABLE t (v TEXT)');
  return db;
}
const values = (db: Db) => db.all<{ v: string }>('SELECT v FROM t ORDER BY rowid').map((r) => r.v);

test('transaction commits and returns the result', () => {
  const db = scratch();
  const out = db.transaction(() => {
    db.run('INSERT INTO t VALUES (?)', 'a');
    return 42;
  });
  assert.equal(out, 42);
  assert.deepEqual(values(db), ['a']);
});

test('transaction rolls back on error', () => {
  const db = scratch();
  assert.throws(() =>
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 'a');
      throw new Error('boom');
    }),
  /boom/);
  assert.deepEqual(values(db), []);
});

test('a failed nested transaction rolls back only its own work', () => {
  const db = scratch();
  db.transaction(() => {
    db.run('INSERT INTO t VALUES (?)', 'outer');
    assert.throws(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 'inner');
        throw new Error('inner failed');
      }),
    );
    db.run('INSERT INTO t VALUES (?)', 'after');
  });
  assert.deepEqual(values(db), ['outer', 'after']);
});

test('the database is usable again after a rollback', () => {
  const db = scratch();
  assert.throws(() => db.transaction(() => { throw new Error('x'); }));
  db.transaction(() => db.run('INSERT INTO t VALUES (?)', 'ok'));
  assert.deepEqual(values(db), ['ok']);
});

test('migrate creates every table and seeds settings', () => {
  const db = new Db(':memory:');
  assert.deepEqual(migrate(db), [1, 2]);
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);
  for (const t of [
    'api_tokens', 'audit_log', 'compose_versions', 'deploy_logs', 'deploys', 'env_vars', 'image_sources',
    'projects', 'registries', 'rendered_files', 'routes', 'schema_migrations', 'sessions', 'settings', 'users',
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal(db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'health_timeout_seconds'`)?.value, '60');
});

test('migrate is idempotent', () => {
  const db = new Db(':memory:');
  migrate(db);
  assert.deepEqual(migrate(db), []);
});

test('foreign keys are enforced', () => {
  const db = new Db(':memory:');
  migrate(db);
  assert.throws(() => db.run(`INSERT INTO routes (project_id, hostname, upstream) VALUES (999, 'x.localhost', 'x:80')`), /FOREIGN KEY/);
});

test('migrate applies new files in order, each in its own transaction', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  const db = new Db(':memory:');
  assert.deepEqual(migrate(db, dir), [1]);

  writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER);');
  writeFileSync(join(dir, '003_bad.sql'), 'CREATE TABLE c (x INTEGER); NOT VALID SQL;');
  assert.throws(() => migrate(db, dir));
  const names = db.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY version').map((r) => r.name);
  assert.deepEqual(names, ['a', 'b']);
  assert.equal(db.get(`SELECT 1 FROM sqlite_master WHERE name = 'c'`), undefined);
});

test('migrate rejects gaps and badly named files', (t) => {
  const gaps = tempDir(t);
  writeFileSync(join(gaps, '001_a.sql'), 'SELECT 1;');
  writeFileSync(join(gaps, '003_c.sql'), 'SELECT 1;');
  assert.throws(() => migrate(new Db(':memory:'), gaps), /without gaps/);

  const badName = tempDir(t);
  writeFileSync(join(badName, 'init.sql'), 'SELECT 1;');
  assert.throws(() => migrate(new Db(':memory:'), badName), /001_name\.sql/);
});

test('migrate refuses a database newer than the build', (t) => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
  const db = new Db(':memory:');
  migrate(db, dir);
  db.run(`INSERT INTO schema_migrations (version, name) VALUES (2, 'future')`);
  assert.throws(() => migrate(db, dir), /older build/);
});

test('file databases use WAL mode', (t) => {
  const db = new Db(join(tempDir(t), 'test.db'));
  assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
  db.close();
});
