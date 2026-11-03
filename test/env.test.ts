import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.ts';
import { composeProject, imageProject, setup } from './helpers.ts';

const isCode = (code: AppError['code'], message?: RegExp) => (err: unknown) =>
  err instanceof AppError && err.code === code && (!message || message.test(err.message));

function withProject() {
  const s = setup();
  const project = s.projects.create(s.ctx, imageProject());
  return { ...s, id: project.id };
}

test('set stores values and never returns secrets', () => {
  const { env, ctx, id, userId } = withProject();
  const list = env.set(ctx, id, {
    set: { PORT: { value: '8080' }, DATABASE_URL: { value: 'postgres://u:pw@db/app', secret: true } },
  });
  assert.deepEqual(
    list.map(({ key, value, isSecret, updatedBy }) => ({ key, value, isSecret, updatedBy })),
    [
      { key: 'DATABASE_URL', value: null, isSecret: true, updatedBy: `user:${userId}` },
      { key: 'PORT', value: '8080', isSecret: false, updatedBy: `user:${userId}` },
    ],
  );
  assert.deepEqual(env.resolve(id), { DATABASE_URL: 'postgres://u:pw@db/app', PORT: '8080' });
});

test('every value is encrypted at rest', () => {
  const { env, ctx, id, db } = withProject();
  env.set(ctx, id, { set: { PLAIN: { value: 'visible-value' }, SECRET: { value: 'hidden-value', secret: true } } });
  const raw = JSON.stringify(db.all('SELECT * FROM env_vars'));
  assert.doesNotMatch(raw, /visible-value|hidden-value/);
});

test('a value copied into another row fails to decrypt', () => {
  const { env, projects, ctx, id, db } = withProject();
  const other = projects.create(ctx, composeProject()).id;
  env.set(ctx, id, { set: { TOKEN: { value: 'abc', secret: true } } });
  env.set(ctx, other, { set: { TOKEN: { value: 'zzz', secret: true } } });
  db.run(
    `UPDATE env_vars SET value_encrypted = (SELECT value_encrypted FROM env_vars WHERE project_id = ?) WHERE project_id = ?`,
    id, other,
  );
  assert.throws(() => env.resolve(other), /Could not decrypt/);
});

test('set overwrites, unsets, and leaves other keys alone', () => {
  const { env, ctx, id } = withProject();
  env.set(ctx, id, { set: { A: { value: '1' }, B: { value: '2' }, C: { value: '3', secret: true } } });
  env.set(ctx, id, { set: { A: { value: 'one' }, C: { value: 'now public' } }, unset: ['B', 'MISSING'] });
  assert.deepEqual(env.resolve(id), { A: 'one', C: 'now public' });
  assert.equal(env.list(id).find((e) => e.key === 'C')?.isSecret, false);
});

test('set rejects bad keys, values, and a key both set and unset', () => {
  const { env, ctx, id } = withProject();
  assert.throws(() => env.set(ctx, id, { set: { '1BAD': { value: 'x' } } }), isCode('validation'));
  assert.throws(() => env.set(ctx, id, { set: { 'A-B': { value: 'x' } } }), isCode('validation'));
  assert.throws(() => env.set(ctx, id, { set: { A: { value: 'a\0b' } } }), isCode('validation'));
  assert.throws(() => env.set(ctx, id, { set: { A: { value: 'x' } }, unset: ['A'] }), isCode('validation', /both/));
  assert.throws(() => env.set(ctx, 999, { set: {} }), isCode('not_found'));
});

test('replace keeps a secret sent without a value and removes keys left out', () => {
  const { env, ctx, id } = withProject();
  env.set(ctx, id, { set: { KEEP: { value: 's3cret', secret: true }, DROP: { value: 'x' }, EDIT: { value: 'old' } } });
  env.replace(ctx, id, [
    { key: 'KEEP', secret: true },
    { key: 'EDIT', value: 'new' },
    { key: 'ADD', value: 'added', secret: true },
  ]);
  assert.deepEqual(env.resolve(id), { ADD: 'added', EDIT: 'new', KEEP: 's3cret' });
});

test('replace refuses to reveal or invent a value', () => {
  const { env, ctx, id } = withProject();
  env.set(ctx, id, { set: { S: { value: 's3cret', secret: true }, P: { value: 'p' } } });
  // Turning a secret into a plain value without supplying it would expose it.
  assert.throws(() => env.replace(ctx, id, [{ key: 'S', secret: false }]), isCode('validation', /S: a value is required/));
  assert.throws(() => env.replace(ctx, id, [{ key: 'P' }]), isCode('validation'));
  assert.throws(() => env.replace(ctx, id, [{ key: 'NEW', secret: true }]), isCode('validation'));
  assert.throws(() => env.replace(ctx, id, [{ key: 'A', value: '1' }, { key: 'A', value: '2' }]), isCode('validation', /unique/));
  // Nothing changed after the failures.
  assert.deepEqual(env.resolve(id), { P: 'p', S: 's3cret' });
});

test('the audit log names keys but never values', () => {
  const { env, audit, ctx, id } = withProject();
  env.set(ctx, id, { set: { TOKEN: { value: 'tok-123', secret: true }, MODE: { value: 'prod-mode' } } });
  env.replace(ctx, id, [{ key: 'TOKEN', secret: true }, { key: 'NEXT', value: 'next-val' }]);
  const [replace, set] = audit.list({ limit: 2 });
  assert.deepEqual(set!.details, { set: ['TOKEN', 'MODE'], unset: [] });
  assert.deepEqual(replace!.details, { set: ['NEXT'], kept: ['TOKEN'], unset: ['MODE'] });
  assert.doesNotMatch(JSON.stringify(audit.list()), /tok-123|prod-mode|next-val/);
});
