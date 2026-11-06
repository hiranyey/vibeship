import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/crypto/tokens.ts';
import { AppError } from '../src/errors.ts';
import { scopeCovers, TOKEN_PREFIX } from '../src/services/tokens.ts';
import { composeProject, imageProject, setup } from './helpers.ts';

const isCode = (code: AppError['code']) => (err: unknown) => err instanceof AppError && err.code === code;

test('a token is shown once, stored only as its hash, and authenticates', () => {
  const { tokens, ctx, db, userId } = setup();
  const { token, apiToken } = tokens.create(ctx, { name: 'ci', scope: 'deploy' });
  assert.ok(token.startsWith(TOKEN_PREFIX));
  assert.equal(apiToken.scope, 'deploy');
  assert.equal(apiToken.createdBy, userId);
  assert.equal(apiToken.lastUsedAt, null);

  const stored = db.all<{ token_hash: string }>('SELECT token_hash FROM api_tokens').map((r) => r.token_hash);
  assert.deepEqual(stored, [sha256Hex(token)]);
  assert.doesNotMatch(JSON.stringify(db.all('SELECT * FROM audit_log')), new RegExp(token.slice(3)));
  assert.ok(!('token' in tokens.get(apiToken.id)));

  assert.equal(tokens.authenticate(token)?.id, apiToken.id);
  assert.ok(tokens.get(apiToken.id).lastUsedAt);
  assert.equal(tokens.authenticate(`${token}x`), null);
  assert.equal(tokens.authenticate(token.slice(TOKEN_PREFIX.length)), null);
});

test('revoked and expired tokens stop working', () => {
  const { tokens, ctx, db } = setup();
  const a = tokens.create(ctx, { name: 'a', scope: 'read' });
  tokens.revoke(ctx, a.apiToken.id);
  assert.equal(tokens.authenticate(a.token), null);
  assert.ok(tokens.get(a.apiToken.id).revokedAt);

  const b = tokens.create(ctx, { name: 'b', scope: 'read', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(tokens.authenticate(b.token));
  db.run(`UPDATE api_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, b.apiToken.id);
  assert.equal(tokens.authenticate(b.token), null);

  assert.deepEqual(db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'token.%' ORDER BY id`).map((r) => r.action),
    ['token.create', 'token.revoke', 'token.create']);
});

test('token input is validated', () => {
  const { tokens, ctx } = setup();
  assert.throws(() => tokens.create(ctx, { name: '', scope: 'read' }), isCode('validation'));
  assert.throws(() => tokens.create(ctx, { name: 'x', scope: 'root' }), isCode('validation'));
  assert.throws(() => tokens.create(ctx, { name: 'x', scope: 'read', expiresAt: '2001-01-01T00:00:00Z' }), isCode('validation'));
  assert.throws(() => tokens.revoke(ctx, 999), isCode('not_found'));
});

test('admin covers deploy, which covers read', () => {
  assert.ok(scopeCovers('admin', 'deploy'));
  assert.ok(scopeCovers('deploy', 'read'));
  assert.ok(scopeCovers('read', 'read'));
  assert.ok(!scopeCovers('read', 'deploy'));
  assert.ok(!scopeCovers('deploy', 'admin'));
});

test('sessions: login creates the user once, and logout or expiry ends the session', () => {
  const { sessions, db } = setup();
  const first = sessions.login({ sub: 'user_abc', email: 'a@example.com', name: 'A' }, { ip: '10.0.0.1', userAgent: 'test' });
  assert.equal(sessions.authenticate(first.token)?.email, 'a@example.com');
  assert.equal(db.get<{ id: string }>('SELECT id FROM sessions')?.id, sha256Hex(first.token));

  const second = sessions.login({ sub: 'user_abc', email: 'new@example.com', name: 'A' }, {});
  assert.equal(second.user.id, first.user.id);
  assert.equal(sessions.authenticate(first.token)?.email, 'new@example.com');

  sessions.logout({ actor: { type: 'user', userId: first.user.id } }, first.token);
  assert.equal(sessions.authenticate(first.token), null);
  assert.ok(sessions.authenticate(second.token));

  db.run(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`);
  assert.equal(sessions.authenticate(second.token), null);
  assert.equal(sessions.authenticate('nonsense'), null);
});

test('webhook tokens: rotating replaces the old one, and only image projects have them', () => {
  const { projects, ctx, db } = setup();
  const p = projects.create(ctx, imageProject());
  const first = projects.rotateWebhook(ctx, p.id);
  assert.equal(first.project.hasWebhook, true);
  assert.equal(projects.findByWebhookToken(first.token)?.id, p.id);
  assert.equal(db.get<{ h: string }>('SELECT webhook_token_hash AS h FROM projects')?.h, sha256Hex(first.token));

  const second = projects.rotateWebhook(ctx, p.id);
  assert.equal(projects.findByWebhookToken(first.token), null);
  assert.equal(projects.findByWebhookToken(second.token)?.id, p.id);

  const c = projects.create(ctx, composeProject());
  assert.throws(() => projects.rotateWebhook(ctx, c.id), isCode('validation'));
  assert.deepEqual(db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY id`).map((r) => r.action),
    ['webhook.create', 'webhook.rotate']);
});

test('active tokens have distinct names; a revoked token frees its name', () => {
  const { tokens, ctx } = setup();
  const first = tokens.create(ctx, { name: 'ci', scope: 'deploy' });
  assert.throws(() => tokens.create(ctx, { name: 'ci', scope: 'read' }), (err: unknown) =>
    isCode('conflict')(err) && (err as AppError).details?.issues !== undefined && /already exists/.test((err as AppError).message));
  tokens.revoke(ctx, first.apiToken.id);
  assert.equal(tokens.create(ctx, { name: 'ci', scope: 'read' }).apiToken.name, 'ci');
});
