import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';

const KEY = generateMasterKey();

const base = {
  PUBLIC_URL: 'http://vibeship.localhost:8080/',
  STACK_ROOT: '/opt/stack',
  BASE_DOMAIN: 'localhost',
  MASTER_KEY: KEY,
};

test('fills in defaults and derives paths from STACK_ROOT', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 3000);
  assert.equal(c.publicUrl, 'http://vibeship.localhost:8080');
  assert.equal(c.dataDir, '/opt/stack/vibeship/data');
  assert.equal(c.dbPath, '/opt/stack/vibeship/data/vibeship.db');
  assert.deepEqual(c.masterKey, Buffer.from(KEY, 'base64'));
  assert.equal(c.tlsMode, 'origin-cert');
  assert.equal(c.caddyAdminUrl, 'http://caddy-api:2019');
  assert.equal(c.oidc, null);
});

test('treats empty values as unset', () => {
  const c = loadConfig({ ...base, PORT: '', OIDC_ISSUER: '' });
  assert.equal(c.port, 3000);
  assert.equal(c.oidc, null);
});

test('lists every invalid setting', () => {
  assert.throws(
    () => loadConfig({ STACK_ROOT: 'relative/path', BASE_DOMAIN: 'Bad Domain', TLS_MODE: 'maybe' }),
    (err: Error) => ['PUBLIC_URL', 'STACK_ROOT', 'BASE_DOMAIN', 'TLS_MODE'].every((k) => err.message.includes(k)),
  );
});

test('requires a 32-byte base64 MASTER_KEY without echoing it', () => {
  const { MASTER_KEY: _, ...withoutKey } = base;
  assert.throws(() => loadConfig(withoutKey), /MASTER_KEY/);
  const short = Buffer.alloc(16, 7).toString('base64');
  for (const bad of [short, 'not base64!', `${KEY}junk`]) {
    assert.throws(
      () => loadConfig({ ...base, MASTER_KEY: bad }),
      (err: Error) => /MASTER_KEY: must be 32 bytes/.test(err.message) && !err.message.includes(bad),
    );
  }
  // Trailing whitespace from copy-paste is fine.
  assert.equal(loadConfig({ ...base, MASTER_KEY: ` ${KEY}\n` }).masterKey.length, 32);
});

test('requires all OIDC settings or none', () => {
  assert.throws(() => loadConfig({ ...base, OIDC_ISSUER: 'https://clerk.example.com' }), /OIDC_/);
  const c = loadConfig({
    ...base,
    OIDC_ISSUER: 'https://clerk.example.com',
    OIDC_CLIENT_ID: 'id',
    OIDC_CLIENT_SECRET: 'secret',
  });
  assert.deepEqual(c.oidc, {
    issuer: 'https://clerk.example.com',
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: `${c.publicUrl}/auth/callback`,
  });
});
