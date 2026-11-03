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
