import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.ts';
import { composeProject, imageProject, setup } from './helpers.ts';

const isCode = (code: AppError['code'], message?: RegExp) => (err: unknown) =>
  err instanceof AppError && err.code === code && (!message || message.test(err.message));

test('creates an image project with a default hostname and route', () => {
  const { projects, ctx, userId } = setup();
  const p = projects.create(ctx, imageProject());
  assert.equal(p.name, 'hello');
  assert.equal(p.kind, 'image');
  assert.equal(p.hostname, 'hello.localhost');
  assert.equal(p.status, 'created');
  assert.equal(p.hasWebhook, false);
  assert.equal(p.createdBy, `user:${userId}`);
  assert.equal(p.upstream, 'hello:8080');
  assert.deepEqual(p.image, {
    registryId: null,
    imageRef: 'localhost:5050/library/hello:latest',
    containerPort: 8080,
    healthPath: '/health',
    memLimit: null,
    currentDigest: null,
  });
  assert.equal(p.compose, null);
  assert.deepEqual(projects.list().map((x) => x.id), [p.id]);
  assert.equal(projects.getByName('hello').id, p.id);
});

test('creates a compose project with version 1', () => {
  const { projects, ctx } = setup();
  const p = projects.create(ctx, composeProject({ hostname: 'my-blog.localhost', note: 'first' }));
  assert.equal(p.hostname, 'my-blog.localhost');
  assert.equal(p.upstream, 'blog:80');
  assert.equal(p.image, null);
  assert.equal(p.compose?.version, 1);
  assert.equal(p.compose?.routedService, 'app');
  assert.equal(p.compose?.note, 'first');
});

test('rejects reserved and malformed names', () => {
  const { projects, ctx } = setup();
  for (const name of ['caddy', 'caddy-api', 'vibeship', 'web']) {
    assert.throws(() => projects.create(ctx, imageProject({ name })), isCode('validation', /reserved/), name);
  }
  for (const name of ['Hello', '1app', 'app-', 'a_b', '', 'x'.repeat(33)]) {
    assert.throws(() => projects.create(ctx, imageProject({ name })), isCode('validation'), name);
  }
});

test('hostnames must be one label under the base domain and not reserved', () => {
  const { projects, ctx } = setup();
  for (const hostname of ['hello.example.com', 'a.b.localhost', 'localhost', 'vibeship.localhost', '-x.localhost']) {
    assert.throws(() => projects.create(ctx, imageProject({ hostname })), isCode('validation'), hostname);
  }
  assert.equal(projects.create(ctx, imageProject({ hostname: 'HELLO.localhost' })).hostname, 'hello.localhost');
});

test('names and hostnames are unique', () => {
  const { projects, ctx } = setup();
  projects.create(ctx, imageProject());
  assert.throws(() => projects.create(ctx, imageProject({ hostname: 'other.localhost' })), isCode('conflict', /named "hello"/));
  assert.throws(() => projects.create(ctx, composeProject({ hostname: 'hello.localhost' })), isCode('conflict', /already used/));
});

test('rejects unknown registries and bad image fields', () => {
  const { projects, ctx } = setup();
  assert.throws(() => projects.create(ctx, imageProject({ registryId: 7 })), isCode('validation', /Registry 7/));
  assert.throws(() => projects.create(ctx, imageProject({ containerPort: 70000 })), isCode('validation'));
  assert.throws(() => projects.create(ctx, imageProject({ imageRef: 'app@sha256:abc' })), isCode('validation'));
  assert.throws(() => projects.create(ctx, imageProject({ healthPath: 'health' })), isCode('validation'));
  assert.throws(() => projects.create(ctx, { kind: 'vm', name: 'x' }), isCode('validation'));
});

test('update changes image fields and keeps the route in step', () => {
  const { projects, ctx, db } = setup();
  const { id } = projects.create(ctx, imageProject());
  const p = projects.update(ctx, id, { hostname: 'hi.localhost', containerPort: 3000, healthPath: null, memLimit: '512m' });
  assert.equal(p.hostname, 'hi.localhost');
  assert.equal(p.upstream, 'hello:3000');
  assert.equal(p.image?.containerPort, 3000);
  assert.equal(p.image?.healthPath, null);
  assert.equal(p.image?.memLimit, '512m');
  assert.deepEqual({ ...db.get<object>('SELECT hostname, upstream FROM routes WHERE project_id = ?', id) }, {
    hostname: 'hi.localhost',
    upstream: 'hello:3000',
  });
  // The old hostname is free again.
  projects.create(ctx, composeProject({ hostname: 'hello.localhost' }));
});

test('update refuses a taken hostname and compose field changes', () => {
  const { projects, ctx } = setup();
  const a = projects.create(ctx, imageProject());
  const b = projects.create(ctx, composeProject());
  assert.throws(() => projects.update(ctx, a.id, { hostname: 'blog.localhost' }), isCode('conflict'));
  assert.throws(() => projects.update(ctx, b.id, { containerPort: 81 }), isCode('validation', /compose version/));
  assert.throws(() => projects.update(ctx, a.id, {}), isCode('validation', /nothing to update/));
  assert.throws(() => projects.update(ctx, 999, { hostname: 'x.localhost' }), isCode('not_found'));
  assert.equal(projects.update(ctx, b.id, { hostname: 'news.localhost' }).hostname, 'news.localhost');
});

test('delete removes the project and everything hanging off it', () => {
  const { projects, env, ctx, db } = setup();
  const { id } = projects.create(ctx, imageProject());
  env.set(ctx, id, { set: { A: { value: '1' } } });
  projects.delete(ctx, id);
  assert.throws(() => projects.get(id), isCode('not_found'));
  for (const table of ['image_sources', 'routes', 'env_vars']) {
    assert.equal(db.get(`SELECT 1 FROM ${table} WHERE project_id = ?`, id), undefined, table);
  }
  assert.throws(() => projects.delete(ctx, id), isCode('not_found'));
});

test('every change is audited with the actor, and failed changes leave no audit row', () => {
  const { projects, audit, ctx, userId } = setup();
  const { id } = projects.create(ctx, imageProject());
  projects.update(ctx, id, { containerPort: 9000 });
  assert.throws(() => projects.create(ctx, imageProject()));
  projects.delete({ actor: { type: 'system' } }, id);

  const entries = audit.list();
  assert.deepEqual(entries.map((e) => e.action), ['project.delete', 'project.update', 'project.create']);
  const [del, upd, create] = entries;
  assert.equal(create!.actorType, 'user');
  assert.equal(create!.userId, userId);
  assert.equal(create!.ip, '127.0.0.1');
  assert.equal(create!.target, `project:${id}`);
  assert.deepEqual(create!.details, { name: 'hello', kind: 'image', hostname: 'hello.localhost' });
  assert.deepEqual(upd!.details, { name: 'hello', changes: { container_port: 9000 } });
  assert.equal(del!.actorType, 'system');
  assert.equal(del!.userId, null);
});
