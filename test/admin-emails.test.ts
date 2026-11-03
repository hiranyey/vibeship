import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { createApp } from '../src/app.ts';
import type { LoginAttempt, OidcClient } from '../src/auth/oidc.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import type { OidcIdentity } from '../src/services/sessions.ts';
import { setup } from './helpers.ts';

const ORIGIN = 'https://vibeship.example.com';

/** Logs in as whoever `who` says, to check ADMIN_EMAILS. */
function harness(t: TestContext, adminEmails: string | undefined, who: OidcIdentity) {
  const s = setup(t);
  const config = loadConfig({
    PUBLIC_URL: ORIGIN, STACK_ROOT: s.stackRoot, BASE_DOMAIN: 'example.com', MASTER_KEY: generateMasterKey(), ADMIN_EMAILS: adminEmails,
  });
  const oidc: OidcClient = {
    async start() {
      const attempt: LoginAttempt = { state: 'st', nonce: 'n', verifier: 'v' };
      return { url: 'https://idp.example/authorize', attempt };
    },
    async finish() {
      return who;
    },
  };
  const app = createApp({ config, db: s.db, services: s, oidc });
  const login = async () => {
    const start = await app.request('/auth/login');
    const loginCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    return app.request('/auth/callback?code=c&state=st', { headers: { cookie: loginCookie } });
  };
  return { ...s, config, login };
}

test('ADMIN_EMAILS is parsed case-insensitively', (t) => {
  const h = harness(t, ' Me@Example.com, other@example.com ,', { sub: 'x', email: '', name: null });
  assert.deepEqual(h.config.adminEmails, ['me@example.com', 'other@example.com']);
});

test('with ADMIN_EMAILS set, a listed and verified email logs in', async (t) => {
  const h = harness(t, 'me@example.com', { sub: 'u1', email: 'ME@example.com', emailVerified: true, name: 'Me' });
  const res = await h.login();
  assert.equal(res.status, 302);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('__Host-vs_session=')));
});

test('with ADMIN_EMAILS set, other or unverified emails are refused and audited', async (t) => {
  for (const who of [
    { sub: 'u2', email: 'stranger@example.com', emailVerified: true, name: null },
    { sub: 'u3', email: 'me@example.com', emailVerified: false, name: null },
    { sub: 'u4', email: '', emailVerified: false, name: null },
  ]) {
    const h = harness(t, 'me@example.com', who);
    const res = await h.login();
    assert.equal(res.status, 403, who.sub);
    assert.ok(!res.headers.getSetCookie().some((c) => c.includes('vs_session=') && !c.includes('Max-Age=0')), 'no session');
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM users')!.n, 1, 'only the fixture user exists');
    const [entry] = h.audit.list({ limit: 1 });
    assert.equal(entry!.action, 'auth.refused');
    assert.equal(entry!.details.sub, who.sub);
  }
});

test('without ADMIN_EMAILS, whoever the provider lets in is admin', async (t) => {
  const h = harness(t, undefined, { sub: 'u5', email: 'anyone@example.com', emailVerified: false, name: null });
  assert.equal((await h.login()).status, 302);
});
