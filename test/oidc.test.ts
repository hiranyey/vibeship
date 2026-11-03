import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { test } from 'node:test';
import { HttpOidcClient } from '../src/auth/oidc.ts';

const ISSUER = 'https://clerk.example.com';
const CLIENT_ID = 'client-1';
const REDIRECT = 'http://vibeship.localhost:8080/auth/callback';

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A pretend identity provider: discovery, keys, and a token endpoint that returns `idToken`. */
function provider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const state = {
    claims: {} as Record<string, unknown>,
    header: { alg: 'RS256', kid: 'k1' } as Record<string, unknown>,
    signingKey: privateKey as KeyObject,
    tokenRequests: [] as URLSearchParams[],
    authHeaders: [] as string[],
    userinfo: null as Record<string, unknown> | null,
  };

  const idToken = () => {
    const data = `${b64(state.header)}.${b64(state.claims)}`;
    const sig = state.header.alg === 'HS256'
      ? createHmac('sha256', 'secret').update(data).digest()
      : state.header.alg === 'none' ? Buffer.alloc(0) : sign('sha256', Buffer.from(data), state.signingKey);
    return `${data}.${sig.toString('base64url')}`;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`) {
      return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    }
    if (url === `${ISSUER}/oauth/token`) {
      state.tokenRequests.push(new URLSearchParams(String(init?.body)));
      state.authHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      return json({ id_token: idToken(), access_token: 'at', token_type: 'Bearer' });
    }
    if (url === `${ISSUER}/oauth/userinfo`) return state.userinfo ? json(state.userinfo) : json({}, 401);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const client = new HttpOidcClient({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 's3cret', redirectUri: REDIRECT }, fetchImpl);
  return { state, client };
}

async function loginWith(p: ReturnType<typeof provider>, claims: Record<string, unknown> = {}) {
  const { url, attempt } = await p.client.start();
  const now = Math.floor(Date.now() / 1000);
  p.state.claims = { iss: ISSUER, sub: 'user_1', aud: CLIENT_ID, exp: now + 300, iat: now, nonce: attempt.nonce, email: 'me@example.com', email_verified: true, name: 'Me', ...claims };
  return { url: new URL(url), attempt, identity: () => p.client.finish('the-code', attempt) };
}

test('start sends the browser to the provider with PKCE, state and nonce', async () => {
  const p = provider();
  const { url, attempt } = await loginWith(p);
  assert.equal(url.origin + url.pathname, `${ISSUER}/oauth/authorize`);
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), REDIRECT);
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('state'), attempt.state);
  assert.equal(q.get('nonce'), attempt.nonce);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('code_challenge'), createHash('sha256').update(attempt.verifier).digest('base64url'));
});

test('finish exchanges the code with the verifier and returns the verified identity', async () => {
  const p = provider();
  const { attempt, identity } = await loginWith(p);
  assert.deepEqual(await identity(), { sub: 'user_1', email: 'me@example.com', emailVerified: true, name: 'Me' });
  const req = p.state.tokenRequests[0]!;
  assert.equal(req.get('grant_type'), 'authorization_code');
  assert.equal(req.get('code'), 'the-code');
  assert.equal(req.get('code_verifier'), attempt.verifier);
  assert.equal(req.get('redirect_uri'), REDIRECT);
  assert.equal(p.state.authHeaders[0], `Basic ${Buffer.from(`${CLIENT_ID}:s3cret`).toString('base64')}`);
});

test('missing email and name come from userinfo when its subject matches', async () => {
  const p = provider();
  p.state.userinfo = { sub: 'user_1', email: 'info@example.com', email_verified: 'true', name: 'Info' };
  const { identity } = await loginWith(p, { email: undefined, email_verified: undefined, name: undefined });
  assert.deepEqual(await identity(), { sub: 'user_1', email: 'info@example.com', emailVerified: true, name: 'Info' });

  p.state.userinfo = { sub: 'someone_else', email: 'x@example.com' };
  const again = await loginWith(p, { email: undefined, name: undefined });
  assert.deepEqual(await again.identity(), { sub: 'user_1', email: '', emailVerified: false, name: null });
});

const rejects: Array<[string, (p: ReturnType<typeof provider>) => Record<string, unknown>, RegExp]> = [
  ['a wrong nonce', () => ({ nonce: 'replayed' }), /nonce/],
  ['another audience', () => ({ aud: 'other-client' }), /another client/],
  ['another issuer', () => ({ iss: 'https://evil.example.com' }), /issuer/],
  ['an expired token', () => ({ exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/],
  ['a token from the future', () => ({ iat: Math.floor(Date.now() / 1000) + 3600 }), /future/],
];
for (const [what, claims, message] of rejects) {
  test(`finish rejects ${what}`, async () => {
    const p = provider();
    const { identity } = await loginWith(p, claims(p));
    await assert.rejects(identity(), message);
  });
}

test('finish rejects a signature from another key, HS256 and alg none', async () => {
  const p = provider();
  p.state.signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects((await loginWith(p)).identity(), /signature is invalid/);

  const q = provider();
  q.state.header = { alg: 'HS256', kid: 'k1' };
  await assert.rejects((await loginWith(q)).identity(), /not supported/);
  q.state.header = { alg: 'none', kid: 'k1' };
  await assert.rejects((await loginWith(q)).identity(), /not supported/);

  const r = provider();
  r.state.header = { alg: 'RS256', kid: 'unknown' };
  await assert.rejects((await loginWith(r)).identity(), /unknown key/);
});
