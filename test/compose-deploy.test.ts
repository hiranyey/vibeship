import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parse } from 'yaml';
import { recoverInterruptedDeploys } from '../src/deploy/recovery.ts';
import { AppError } from '../src/errors.ts';
import { composeProject, setup } from './helpers.ts';

const APP = 'localhost:5050/library/app:v1';
const DB = 'localhost:5050/library/db:v1';

/** Two services, `app` (routed) and `db`, like the compose-two-apps fixture. */
const yaml = (appImage = APP) => `services:
  app:
    image: ${appImage}
    environment: { DB_URL: "http://db:5432" }
    depends_on: [db]
  db:
    image: ${DB}
    volumes: ["dbdata:/var/lib/db"]
volumes:
  dbdata:
`;

const isCode = (code: AppError['code'], message?: RegExp) => (err: unknown) =>
  err instanceof AppError && err.code === code && (!message || message.test(err.message));

async function deployedCompose(t: TestContext) {
  const s = setup(t);
  s.fakeDocker.push(APP, 'healthy');
  s.fakeDocker.push(DB, 'healthy');
  const project = s.projects.create(s.ctx, composeProject({ composeYaml: yaml(), port: 8080, healthPath: '/health' }));
  const first = s.deploys.request(s.ctx, project.id, {}, 'ui');
  await s.queue.idle();
  assert.equal(s.deploys.get(first.id).status, 'healthy', s.deploys.logs(first.id).map((l) => l.line).join('\n'));
  return { ...s, project, first };
}

test('a compose project deploys every service, health checks the routed one and routes to it', async (t) => {
  const s = await deployedCompose(t);
  assert.deepEqual(s.fakeDocker.calls, ['config blog', 'compose-pull blog', 'up blog']);
  assert.deepEqual([...s.fakeDocker.containers.keys()].sort(), ['blog-blog-1', 'blog-db-1']);

  const p = s.projects.get(s.project.id);
  assert.equal(p.status, 'running');
  assert.equal(p.deployedComposeVersion, 1);
  assert.equal(s.deploys.get(s.first.id).composeVersionId, p.compose!.id);
  assert.deepEqual([...s.fakeCaddy.routes.values()], [{ routeId: 1, hostname: 'blog.localhost', upstream: 'blog:8080' }]);
  assert.deepEqual(s.routes.desired().map((r) => r.upstream), ['blog:8080']);
  assert.ok(s.deploys.logs(s.first.id).some((l) => l.line === 'Healthy: http://blog:8080/health answered HTTP 200'));

  // What was written is the patched file, not the user's text.
  const written = parse(readFileSync(join(s.stackRoot, 'blog', 'compose.yaml'), 'utf8')) as { name: string; services: Record<string, unknown> };
  assert.equal(written.name, 'blog');
  assert.deepEqual(Object.keys(written.services), ['blog', 'db']);
  assert.deepEqual(s.deploys.drift(s.project.id), { files: [{ path: '.env', state: 'ok' }, { path: 'compose.yaml', state: 'ok' }], pendingChanges: false });
});

test('a broken compose version fails and the last healthy version is brought back', async (t) => {
  const s = await deployedCompose(t);
  s.fakeDocker.push('localhost:5050/library/app:broken', 'crash');
  s.projects.addComposeVersion(s.ctx, s.project.id, { composeYaml: yaml('localhost:5050/library/app:broken'), routedService: 'app', port: 8080, note: 'oops' });
  assert.equal(s.deploys.drift(s.project.id).pendingChanges, false, 'a saved version is not live until deployed');

  const d = s.deploys.request(s.ctx, s.project.id, {}, 'ui');
  await s.queue.idle();
  const failed = s.deploys.get(d.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.failureReason!, /crashed/);
  assert.equal(s.fakeDocker.containers.get('blog-blog-1')?.image, APP);
  const p = s.projects.get(s.project.id);
  assert.equal(p.status, 'running');
  assert.equal(p.deployedComposeVersion, 1);
  assert.equal(p.compose!.version, 2);
  assert.ok(s.deploys.logs(d.id).some((l) => l.line === 'Bringing back the last healthy version, compose version 1'));
});

test('a failed pull starts nothing and puts the files back', async (t) => {
  const s = await deployedCompose(t);
  s.projects.addComposeVersion(s.ctx, s.project.id, { composeYaml: yaml('localhost:5050/library/app:missing'), routedService: 'app', port: 8080 });
  const d = s.deploys.request(s.ctx, s.project.id, {}, 'ui');
  await s.queue.idle();
  assert.match(s.deploys.get(d.id).failureReason!, /pull access denied/);
  assert.equal(s.fakeDocker.calls.filter((c) => c.startsWith('up')).length, 1);
  assert.match(readFileSync(join(s.stackRoot, 'blog', 'compose.yaml'), 'utf8'), /library\/app:v1/);
  assert.deepEqual(s.deploys.drift(s.project.id).files.map((f) => f.state), ['ok', 'ok']);
  assert.equal(s.projects.get(s.project.id).status, 'running');
});

test('a version docker compose config rejects is not started', async (t) => {
  const s = await deployedCompose(t);
  s.fakeDocker.configError = 'service "app" depends on undefined service "x"';
  const d = s.deploys.request(s.ctx, s.project.id, {}, 'ui');
  await s.queue.idle();
  assert.match(s.deploys.get(d.id).failureReason!, /undefined service/);
  assert.equal(s.fakeDocker.calls.filter((c) => c.startsWith('up')).length, 1);
});

test('an earlier version can be deployed again, and a new port moves the route', async (t) => {
  const s = await deployedCompose(t);
  s.projects.addComposeVersion(s.ctx, s.project.id, { composeYaml: yaml(), routedService: 'app', port: 9090 });
  await s.queue.idle();
  const v2 = s.deploys.request(s.ctx, s.project.id, {}, 'api');
  await s.queue.idle();
  assert.equal(s.deploys.get(v2.id).status, 'healthy');
  assert.equal([...s.fakeCaddy.routes.values()][0]!.upstream, 'blog:9090');

  const back = s.deploys.request(s.ctx, s.project.id, { composeVersion: 1 }, 'api');
  await s.queue.idle();
  assert.equal(s.deploys.get(back.id).status, 'healthy');
  assert.equal(s.projects.get(s.project.id).deployedComposeVersion, 1);
  assert.equal([...s.fakeCaddy.routes.values()][0]!.upstream, 'blog:8080');

  assert.throws(() => s.deploys.request(s.ctx, s.project.id, { composeVersion: 7 }, 'api'), isCode('not_found'));
  assert.throws(() => s.deploys.request(s.ctx, s.project.id, { digest: `sha256:${'a'.repeat(64)}` }, 'api'), isCode('validation', /image projects/));
});

test('compose versions are checked on save, numbered, and audited', (t) => {
  const s = setup(t);
  assert.throws(() => s.projects.create(s.ctx, composeProject({ composeYaml: 'services:\n  app:\n    image: x\n    privileged: true\n' })),
    isCode('validation', /services\.app\.privileged/));
  assert.equal(s.projects.list().length, 0);

  const p = s.projects.create(s.ctx, composeProject());
  assert.throws(() => s.projects.addComposeVersion(s.ctx, p.id, { composeYaml: 'services:\n  app:\n    image: x\n    volumes: ["/:/host"]\n', routedService: 'app', port: 80 }),
    isCode('validation', /bind mounts may only use \.\/data/));
  const v2 = s.projects.addComposeVersion(s.ctx, p.id, { composeYaml: composeProject().composeYaml, routedService: 'app', port: 80, note: 'second' });
  assert.equal(v2.version, 2);
  assert.deepEqual(s.projects.listComposeVersions(p.id).map((v) => [v.version, v.note]), [[2, 'second'], [1, null]]);
  assert.equal(s.projects.getComposeVersion(p.id, 1).composeYaml, composeProject().composeYaml);
  assert.ok(s.audit.list().some((e) => e.action === 'compose.version' && e.details.version === 2));

  const image = s.projects.create(s.ctx, { kind: 'image', name: 'img', imageRef: 'x/y:z', containerPort: 80 });
  assert.throws(() => s.projects.addComposeVersion(s.ctx, image.id, { composeYaml: 'services: {}', routedService: 'app', port: 80 }), isCode('validation'));
});

test('env names compose would read as its own settings are refused', (t) => {
  const s = setup(t);
  const p = s.projects.create(s.ctx, composeProject());
  for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'DOCKER_HOST', 'compose_profiles']) {
    assert.throws(() => s.env.set(s.ctx, p.id, { set: { [key]: { value: 'x' } } }), isCode('validation', /reserved/), key);
  }
});

test('an interrupted compose deploy queues a recovery of the live version', async (t) => {
  const s = await deployedCompose(t);
  const v1 = s.projects.get(s.project.id).compose!.id;
  s.projects.addComposeVersion(s.ctx, s.project.id, { composeYaml: yaml(), routedService: 'app', port: 8080 });
  const cut = s.db.run(`INSERT INTO deploys (project_id, trigger, status, actor) VALUES (?, 'ui', 'running', 'user:1')`, s.project.id).lastInsertRowid;

  await recoverInterruptedDeploys({ db: s.db, docker: s.fakeDocker, audit: s.audit, files: s.files });
  assert.equal(s.deploys.get(cut).failureReason, 'interrupted by restart');
  const recovery = s.deploys.list(s.project.id).find((d) => d.trigger === 'recovery')!;
  assert.equal(recovery.composeVersionId, v1);
  s.queue.kick(s.project.id);
  await s.queue.idle();
  assert.equal(s.deploys.get(recovery.id).status, 'healthy');
});

test('removing a compose project with its data also removes its named volumes', async (t) => {
  const s = await deployedCompose(t);
  await s.deploys.removeProject(s.ctx, s.project.id, { deleteData: true });
  assert.ok(s.fakeDocker.calls.includes('down blog --volumes'));
  assert.equal(s.fakeDocker.containers.size, 0);
});
