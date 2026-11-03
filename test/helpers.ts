import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { RequestContext } from '../src/actor.ts';
import { Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { createServices } from '../src/services/index.ts';

export const BASE_DOMAIN = 'localhost';

/** A migrated in-memory database with the service layer on top. */
export function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const userId = db.run(`INSERT INTO users (oidc_sub, email) VALUES ('user_1', 'me@example.com')`).lastInsertRowid;
  const ctx: RequestContext = { actor: { type: 'user', userId }, ip: '127.0.0.1' };
  const services = createServices({ db, config: { baseDomain: BASE_DOMAIN, masterKey: randomBytes(32) } });
  return { db, ctx, userId, ...services };
}

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeship-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const imageProject = (overrides: Record<string, unknown> = {}) => ({
  kind: 'image',
  name: 'hello',
  imageRef: 'localhost:5050/library/hello:latest',
  containerPort: 8080,
  healthPath: '/health',
  ...overrides,
});

export const composeProject = (overrides: Record<string, unknown> = {}) => ({
  kind: 'compose',
  name: 'blog',
  composeYaml: 'services:\n  app:\n    image: nginx:1.29\n',
  routedService: 'app',
  port: 80,
  ...overrides,
});
