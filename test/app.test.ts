import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import { AppError } from '../src/errors.ts';
import { setup } from './helpers.ts';

function app() {
  const s = setup();
  const config = loadConfig({
    PUBLIC_URL: 'http://vibeship.localhost:8080',
    STACK_ROOT: '/tmp/stack',
    BASE_DOMAIN: 'localhost',
    MASTER_KEY: generateMasterKey(),
  });
  const a = createApp({ config, db: s.db, services: s, oidc: null });
  a.get('/boom/app', () => { throw new AppError('conflict', 'taken', { field: 'name' }); });
  a.get('/boom/other', () => { throw new Error('secret internals'); });
  return a;
}

test('GET /healthz checks the database', async () => {
  const res = await app().request('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET / sends visitors without a session to the login', async () => {
  const res = await app().request('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login');
});

test('AppErrors map to their status; other errors are hidden', async (t) => {
  const a = app();
  const res = await a.request('/boom/app');
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: { code: 'conflict', message: 'taken', field: 'name' } });

  t.mock.method(console, 'error', () => {});
  const res2 = await a.request('/boom/other');
  assert.equal(res2.status, 500);
  assert.doesNotMatch(await res2.text(), /secret internals/);
});
