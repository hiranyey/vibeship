import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { generateMasterKey, parseMasterKey } from '../src/crypto/master-key.ts';
import { SecretBox } from '../src/crypto/secret-box.ts';
import { randomToken, sha256Hex } from '../src/crypto/tokens.ts';

test('generated master keys parse back to 32 random bytes', () => {
  const a = generateMasterKey();
  assert.match(a, /^[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(a, generateMasterKey());
  assert.deepEqual(parseMasterKey(a), Buffer.from(a, 'base64'));
  assert.equal(parseMasterKey(`  ${a}\n`)?.length, 32);
});

test('master keys of the wrong length or alphabet are refused', () => {
  for (const bad of ['', randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), randomBytes(32).toString('hex'), 'a b c']) {
    assert.equal(parseMasterKey(bad), null, bad);
  }
});

test('SecretBox round-trips values, including unicode and empty strings', () => {
  const box = new SecretBox(randomBytes(32));
  for (const value of ['postgres://u:p@db/app', '', 'नमस्ते 🚀', 'x'.repeat(10_000)]) {
    assert.equal(box.open(box.seal(value, 'env:1:K'), 'env:1:K'), value);
  }
});

test('SecretBox uses a fresh IV for every seal', () => {
  const box = new SecretBox(randomBytes(32));
  assert.notEqual(box.seal('same', 'ctx'), box.seal('same', 'ctx'));
});

test('SecretBox rejects the wrong context, the wrong key and tampering', () => {
  const key = randomBytes(32);
  const box = new SecretBox(key);
  const sealed = box.seal('hunter2', 'env:1:PASSWORD');

  assert.throws(() => box.open(sealed, 'env:2:PASSWORD'), /Could not decrypt/);
  assert.throws(() => new SecretBox(randomBytes(32)).open(sealed, 'env:1:PASSWORD'), /Could not decrypt/);

  const parts = sealed.split(':');
  const ct = Buffer.from(parts[2]!, 'base64url');
  ct[0]! ^= 1;
  parts[2] = ct.toString('base64url');
  assert.throws(() => box.open(parts.join(':'), 'env:1:PASSWORD'), /Could not decrypt/);

  assert.throws(() => box.open('v0:a:b:c', 'ctx'), /Malformed/);
  assert.throws(() => new SecretBox(randomBytes(16)), /32 bytes/);
});

test('tokens are random base64url and hash to SHA-256 hex', () => {
  const a = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomToken());
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
