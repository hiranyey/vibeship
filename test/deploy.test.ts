import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError } from '../src/errors.ts';
import { imageProject, setup } from './helpers.ts';
import type { TestContext } from 'node:test';

const REF = 'localhost:5050/library/hello:latest';

/** A project with a healthy v1 already deployed. */
async function deployed(t: TestContext, overrides: Record<string, unknown> = {}) {
  const s = setup(t);
  const v1 = s.fakeDocker.push(REF, 'healthy');
  const project = s.projects.create(s.ctx, imageProject(overrides));
  const first = s.deploys.request(s.ctx, project.id, {}, 'ui');
  await s.queue.idle();
  assert.equal(s.deploys.get(first.id).status, 'healthy');
  return { ...s, project, v1, first };
}

const messages = (s: ReturnType<typeof setup>, deployId: number) => s.deploys.logs(deployId).map((l) => l.line);

test('a healthy deploy pulls, renders, starts, routes and records the digest', async (t) => {
  const s = setup(t);
  const digest = s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject());
  s.env.set(s.ctx, id, { set: { GREETING: { value: 'hi' }, TOKEN: { value: 's3cret', secret: true } } });

  const queued = s.deploys.request(s.ctx, id, {}, 'ui');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.digest, null);
  await s.queue.idle();

  const d = s.deploys.get(queued.id);
  assert.equal(d.status, 'healthy');
  assert.equal(d.digest, digest);
  assert.ok(d.startedAt && d.finishedAt);
  const p = s.projects.get(id);
  assert.equal(p.status, 'running');
  assert.equal(p.image?.currentDigest, digest);

  assert.deepEqual(s.fakeDocker.calls, [`pull ${REF}`, 'up hello']);
  assert.equal(s.fakeDocker.runningDigest('hello'), digest);
  assert.deepEqual([...s.fakeCaddy.routes.values()], [{ routeId: 1, hostname: 'hello.localhost', upstream: 'hello:8080' }]);

  const dir = join(s.stackRoot, 'hello');
  assert.match(readFileSync(join(dir, 'compose.yaml'), 'utf8'), new RegExp(`library/hello@${digest}`));
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /TOKEN="s3cret"/);
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(dir, 'data')));

  const log = messages(s, d.id);
  assert.ok(log.some((l) => l.includes('Healthy: http://hello:8080/health answered HTTP 200')), log.join('\n'));
  assert.ok(log.includes(`Deploy #${d.id} is live`));
});

test('deploying a specific digest pulls it pinned', async (t) => {
  const s = await deployed(t);
  const v2 = s.fakeDocker.push('localhost:5050/library/hello:v2', 'healthy');
  const d = s.deploys.request(s.ctx, s.project.id, { digest: v2 }, 'api');
  await s.queue.idle();
  assert.equal(s.deploys.get(d.id).status, 'healthy');
  assert.ok(s.fakeDocker.calls.includes(`pull localhost:5050/library/hello@${v2}`));
  assert.equal(s.projects.get(s.project.id).image?.currentDigest, v2);
});

for (const [behavior, reason] of [
  ['crash', /crashed and is restarting/],
  ['unhealthy', /timed out after 0.3s: http:\/\/hello:8080\/health answered HTTP 500/],
  ['never-starts', /timed out after 0.3s: container is created/],
] as const) {
  test(`a ${behavior} image over a healthy one brings the healthy one back`, async (t) => {
    const s = await deployed(t);
    const bad = s.fakeDocker.push('localhost:5050/library/hello:bad', behavior);
    const d = s.deploys.request(s.ctx, s.project.id, { digest: bad }, 'webhook');
    await s.queue.idle();

    const result = s.deploys.get(d.id);
    assert.equal(result.status, 'failed');
    assert.match(result.failureReason!, reason);
    assert.equal(s.fakeDocker.runningDigest('hello'), s.v1);
    const p = s.projects.get(s.project.id);
    assert.equal(p.status, 'running');
    assert.equal(p.image?.currentDigest, s.v1);
    assert.match(readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8'), new RegExp(s.v1));
    assert.ok(messages(s, d.id).includes('The last healthy version is serving again'));
  });
}

test('without a health path, the container must stay up for a while', async (t) => {
  const s = setup(t);
  s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject({ healthPath: null }));
  const d = s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  assert.equal(s.deploys.get(d.id).status, 'healthy');
  assert.ok(messages(s, d.id).some((l) => l.startsWith('Healthy: the container stayed up')));
});

test('a failed first deploy stops the broken container', async (t) => {
  const s = setup(t);
  s.fakeDocker.push(REF, 'crash');
  const { id } = s.projects.create(s.ctx, imageProject());
  const d = s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  assert.equal(s.deploys.get(d.id).status, 'failed');
  assert.equal(s.projects.get(id).status, 'failed');
  assert.equal(s.fakeDocker.containers.has('hello'), false);
  assert.equal(s.fakeCaddy.routes.size, 0);
});

test('a digest from another repository fails before anything changes', async (t) => {
  const s = await deployed(t);
  const foreign = s.fakeDocker.push('localhost:5050/other/app:latest', 'healthy');
  const d = s.deploys.request(s.ctx, s.project.id, { digest: foreign }, 'webhook');
  await s.queue.idle();
  const result = s.deploys.get(d.id);
  assert.equal(result.status, 'failed');
  assert.match(result.failureReason!, /not found/);
  assert.equal(s.fakeDocker.calls.filter((c) => c.startsWith('up')).length, 1);
  assert.equal(s.projects.get(s.project.id).status, 'running');
  assert.ok(messages(s, d.id).some((l) => l.startsWith('Nothing was changed')));
});

test('a Caddy outage does not fail an otherwise healthy deploy', async (t) => {
  const s = setup(t);
  s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject());
  s.fakeCaddy.down = true;
  const d = s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  assert.equal(s.deploys.get(d.id).status, 'healthy');
  assert.ok(messages(s, d.id).some((l) => l.startsWith('Warning: could not update the Caddy route')));

  s.fakeCaddy.down = false;
  assert.equal(await s.routes.reconcile(), true);
  assert.deepEqual([...s.fakeCaddy.routes.keys()], [1]);
});

test('deploys for one project run one at a time, in order', async (t) => {
  const s = await deployed(t);
  const v2 = s.fakeDocker.push('localhost:5050/library/hello:v2', 'healthy');
  const v3 = s.fakeDocker.push('localhost:5050/library/hello:v3', 'healthy');
  let running = 0;
  let maxRunning = 0;
  s.fakeDocker.onComposeUp = async () => {
    maxRunning = Math.max(maxRunning, ++running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
  };
  const a = s.deploys.request(s.ctx, s.project.id, { digest: v2 }, 'api');
  const b = s.deploys.request(s.ctx, s.project.id, { digest: v3 }, 'api');
  assert.equal(s.deploys.get(b.id).status, 'queued');
  await s.queue.idle();
  assert.equal(maxRunning, 1);
  assert.ok(s.deploys.get(a.id).finishedAt! <= s.deploys.get(b.id).startedAt!);
  assert.equal(s.projects.get(s.project.id).image?.currentDigest, v3);
  assert.deepEqual(s.deploys.list(s.project.id).map((x) => x.id), [b.id, a.id, s.first.id]);
});

test('deploy requests are validated and audited', async (t) => {
  const s = await deployed(t);
  const isValidation = (e: unknown) => e instanceof AppError && e.code === 'validation';
  assert.throws(() => s.deploys.request(s.ctx, s.project.id, { digest: 'latest' }, 'api'), isValidation);
  assert.throws(() => s.deploys.request(s.ctx, s.project.id, { composeVersion: 2 }, 'api'), isValidation);
  assert.throws(() => s.deploys.request(s.ctx, 999, {}, 'api'), (e: unknown) => e instanceof AppError && e.code === 'not_found');
  const entry = s.audit.list().find((e) => e.action === 'deploy.request');
  assert.deepEqual(entry?.details, { project: 'hello', digest: 'latest', trigger: 'ui' });
});

test('the project registry supplies pull credentials', async (t) => {
  const s = setup(t);
  s.fakeDocker.push(REF, 'healthy');
  s.registries.create(s.ctx, { name: 'local', url: 'http://localhost:5050', username: 'ci', token: 'tok' });
  const { id } = s.projects.create(s.ctx, imageProject());
  s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  assert.deepEqual(s.fakeDocker.pulls.at(-1)?.auth, { host: 'localhost:5050', username: 'ci', password: 'tok' });
  assert.equal(JSON.stringify(s.registries.list()).includes('tok'), false);
});

test('drift tells hand edits apart from changes not yet deployed', async (t) => {
  const s = await deployed(t);
  const id = s.project.id;
  assert.deepEqual(s.deploys.drift(id), {
    files: [{ path: '.env', state: 'ok' }, { path: 'compose.yaml', state: 'ok' }],
    pendingChanges: false,
  });

  s.env.set(s.ctx, id, { set: { NEW: { value: '1' } } });
  assert.equal(s.deploys.drift(id).pendingChanges, true);

  const compose = join(s.stackRoot, 'hello', 'compose.yaml');
  writeFileSync(compose, readFileSync(compose, 'utf8') + '# edited by hand\n');
  assert.deepEqual(s.deploys.drift(id).files, [{ path: '.env', state: 'ok' }, { path: 'compose.yaml', state: 'modified' }]);

  s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  assert.deepEqual(s.deploys.drift(id), {
    files: [{ path: '.env', state: 'ok' }, { path: 'compose.yaml', state: 'ok' }],
    pendingChanges: false,
  });
});

test('removing a project stops it, drops its route and files, and keeps data unless asked', async (t) => {
  const s = await deployed(t);
  const dir = join(s.stackRoot, 'hello');
  writeFileSync(join(dir, 'data', 'keep.txt'), 'x');
  await s.deploys.removeProject(s.ctx, s.project.id);
  assert.equal(s.fakeDocker.containers.has('hello'), false);
  assert.equal(s.fakeCaddy.routes.size, 0);
  assert.equal(existsSync(join(dir, 'compose.yaml')), false);
  assert.equal(existsSync(join(dir, 'data', 'keep.txt')), true);
  assert.throws(() => s.projects.get(s.project.id));

  const again = s.projects.create(s.ctx, imageProject());
  s.deploys.request(s.ctx, again.id, {}, 'ui');
  await s.queue.idle();
  await s.deploys.removeProject(s.ctx, again.id, { deleteData: true });
  assert.equal(existsSync(dir), false);
});

test('a project with a deploy in progress can not be removed', async (t) => {
  const s = await deployed(t);
  let release!: () => void;
  s.fakeDocker.onComposeUp = () => new Promise((r) => { release = r; });
  s.deploys.request(s.ctx, s.project.id, {}, 'ui');
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(s.deploys.removeProject(s.ctx, s.project.id), (e: unknown) => e instanceof AppError && e.code === 'conflict');
  release();
  await s.queue.idle();
});
