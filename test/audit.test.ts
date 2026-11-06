import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test('records each actor type in its own column', () => {
  const { audit, db, ctx, userId } = setup();
  const tokenId = db.run(`INSERT INTO api_tokens (name, token_hash, scope) VALUES ('agent', 'h', 'deploy')`).lastInsertRowid;
  audit.record(ctx, 'a.user', 'project:1');
  audit.record({ actor: { type: 'token', tokenId } }, 'a.token', null, { n: 1 });
  audit.record({ actor: { type: 'system' } }, 'a.system', null);

  const [system, token, user] = audit.list();
  assert.deepEqual(
    [user, token, system].map((e) => [e!.action, e!.actorType, e!.userId, e!.tokenId]),
    [
      ['a.user', 'user', userId, null],
      ['a.token', 'token', null, tokenId],
      ['a.system', 'system', null, null],
    ],
  );
  assert.deepEqual(token!.details, { n: 1 });
  assert.match(user!.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('lists newest first and pages with beforeId', () => {
  const { audit, ctx } = setup();
  for (let i = 1; i <= 5; i++) audit.record(ctx, `step.${i}`, null);
  const page1 = audit.list({ limit: 2 });
  assert.deepEqual(page1.map((e) => e.action), ['step.5', 'step.4']);
  const page2 = audit.list({ limit: 2, beforeId: page1.at(-1)!.id });
  assert.deepEqual(page2.map((e) => e.action), ['step.3', 'step.2']);
});

test('an audit row inside a rolled-back transaction is discarded', () => {
  const { audit, db, ctx } = setup();
  assert.throws(() =>
    db.transaction(() => {
      audit.record(ctx, 'doomed', null);
      throw new Error('rollback');
    }),
  );
  assert.deepEqual(audit.list(), []);
});

test('filters by action, actor, target type, time and action prefix, and lists the facets', () => {
  const { audit, db, ctx, userId } = setup();
  const tokenId = db.run(`INSERT INTO api_tokens (name, token_hash, scope) VALUES ('agent', 'h', 'deploy')`).lastInsertRowid;
  audit.record(ctx, 'auth.login', `user:${userId}`);
  audit.record(ctx, 'project.create', 'project:1', { name: 'a' });
  audit.record({ actor: { type: 'token', tokenId } }, 'project.delete', 'project:1', { name: 'a' });
  audit.record({ actor: { type: 'system' } }, 'deploy.request', 'deploy:7', { trigger: 'webhook' });
  db.run(`UPDATE audit_log SET ts = '2026-01-02T10:00:00.000Z' WHERE action = 'project.create'`);

  const actions = (f: Parameters<typeof audit.list>[0]) => audit.list(f).map((e) => e.action);
  assert.deepEqual(actions({ action: 'project.delete' }), ['project.delete']);
  assert.deepEqual(actions({ actor: { type: 'token', id: tokenId } }), ['project.delete']);
  assert.deepEqual(actions({ actor: { type: 'user', id: userId } }), ['project.create', 'auth.login']);
  assert.deepEqual(actions({ actor: { type: 'system' } }), ['deploy.request']);
  assert.deepEqual(actions({ targetType: 'project' }), ['project.delete', 'project.create']);
  assert.deepEqual(actions({ targetType: 'proj' }), [], 'a target type matches whole, not as a prefix');
  assert.deepEqual(actions({ since: '2026-01-02T00:00:00.000Z', until: '2026-01-03T00:00:00.000Z' }), ['project.create']);
  assert.deepEqual(actions({ excludeActionPrefixes: ['auth.'] }), ['deploy.request', 'project.delete', 'project.create']);

  const f = audit.facets();
  assert.deepEqual(f.actions, ['auth.login', 'deploy.request', 'project.create', 'project.delete']);
  assert.deepEqual(f.targetTypes, ['deploy', 'project', 'user']);
  assert.deepEqual(f.actors, [{ type: 'system' }, { type: 'token', id: tokenId }, { type: 'user', id: userId }]);
});

test('searches action, target and details, filters by action prefixes, and counts matches', () => {
  const { audit, ctx } = setup();
  audit.record(ctx, 'project.create', 'project:1', { name: 'deploy-or-die', hostname: 'deploy-or-die.example.com' });
  audit.record(ctx, 'deploy.request', 'deploy:4', { project: 'deploy-or-die' });
  audit.record(ctx, 'token.create', 'token:2', { name: 'ci-bot' });
  audit.record(ctx, 'auth.login', 'user:1');

  const actions = (f: Parameters<typeof audit.list>[0]) => audit.list(f).map((e) => e.action);
  assert.deepEqual(actions({ search: 'DEPLOY-OR-DIE' }), ['deploy.request', 'project.create'], 'case-insensitive, in details');
  assert.deepEqual(actions({ search: 'token:2' }), ['token.create'], 'in the target');
  assert.deepEqual(actions({ search: '50%_' }), [], 'no wildcards');
  assert.deepEqual(actions({ actionPrefixes: ['project.', 'token.'] }), ['token.create', 'project.create']);
  assert.equal(audit.count(), 4);
  assert.equal(audit.count({ actionPrefixes: ['deploy.'] }), 1);
  assert.equal(audit.count({ excludeActionPrefixes: ['auth.'], search: 'deploy' }), 2);
});
