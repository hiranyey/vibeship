import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { RequestContext } from '../src/actor.ts';
import { Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { createServices } from '../src/services/index.ts';
import { FakeCaddy, FakeDocker } from './fakes.ts';

export const BASE_DOMAIN = 'localhost';

/** Fast health timing so failing deploys finish in milliseconds. */
export const FAST_TIMING = { timeoutMs: 300, pollMs: 5, stableMs: 20 };

/**
 * A migrated in-memory database with the service layer on top, wired to a
 * fake Docker and Caddy and a temporary STACK_ROOT (removed after the test
 * when `t` is given).
 */
export function setup(t?: TestContext) {
  const db = new Db(':memory:');
  migrate(db);
  const userId = db.run(`INSERT INTO users (oidc_sub, email) VALUES ('user_1', 'me@example.com')`).lastInsertRowid;
  const ctx: RequestContext = { actor: { type: 'user', userId }, ip: '127.0.0.1' };
  const stackRoot = mkdtempSync(join(tmpdir(), 'vibeship-stack-'));
  t?.after(() => rmSync(stackRoot, { recursive: true, force: true }));
  const docker = new FakeDocker();
  const caddy = new FakeCaddy();
  const services = createServices({
    db,
    config: { baseDomain: BASE_DOMAIN, masterKey: randomBytes(32), stackRoot, caddyAdminUrl: 'http://caddy-api:2019' },
    docker,
    caddy,
    probe: docker.probe,
    timing: FAST_TIMING,
  });
  return { ...services, db, ctx, userId, stackRoot, fakeDocker: docker, fakeCaddy: caddy };
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
