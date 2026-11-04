import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { createApp } from '../src/app.ts';
import type { LoginAttempt, OidcClient } from '../src/auth/oidc.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import { composeProject, imageProject, setup } from './helpers.ts';

const ORIGIN = 'http://vibeship.localhost:8080';
const REF = 'localhost:5050/library/hello:latest';

/** Stands in for Clerk: any login with code "good" succeeds as the same person. */
class FakeOidc implements OidcClient {
  async start() {
    const attempt: LoginAttempt = { state: `state-${Math.random()}`, nonce: 'n', verifier: 'v' };
    return { url: `https://idp.example/authorize?state=${attempt.state}`, attempt };
  }
  async finish(code: string) {
    if (code !== 'good') throw new Error('invalid_grant');
    return { sub: 'user_clerk', email: 'admin@example.com', name: 'Admin' };
  }
}

function harness(t: TestContext, opts: { oidc?: OidcClient | null } = {}) {
  const s = setup(t);
  const config = loadConfig({ PUBLIC_URL: ORIGIN, STACK_ROOT: s.stackRoot, BASE_DOMAIN: 'localhost', MASTER_KEY: generateMasterKey() });
  const app = createApp({ config, db: s.db, services: s, oidc: opts.oidc === undefined ? new FakeOidc() : opts.oidc });
  const tokens = Object.fromEntries(
    (['read', 'deploy', 'admin'] as const).map((scope) => [scope, s.tokens.create(s.ctx, { name: scope, scope }).token]),
  ) as Record<'read' | 'deploy' | 'admin', string>;

  /** A request with a bearer token (by scope name), a cookie header, or neither. */
  const call = (method: string, path: string, o: { as?: keyof typeof tokens; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.as) headers.authorization = `Bearer ${tokens[o.as]}`;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    return app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  };
  return { ...s, app, call, tokens };
}

/** Logs in through the fake provider and returns the session cookie header. */
async function login(h: ReturnType<typeof harness>, returnTo?: string): Promise<{ cookie: string; location: string }> {
  const start = await h.call('GET', `/auth/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const loginCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  assert.match(start.headers.get('set-cookie')!, /HttpOnly/i);

  const cb = await h.call('GET', `/auth/callback?code=good&state=${state}`, { cookie: loginCookie });
  assert.equal(cb.status, 302);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('vs_session='))!;
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
  return { cookie: session.split(';')[0]!, location: cb.headers.get('location')! };
}

/** Parses a finished server-sent events body into events. */
function sse(text: string): Array<{ event: string; id?: string; data: string }> {
  return text.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((block) => {
    const e: { event: string; id?: string; data: string } = { event: 'message', data: '' };
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(': ');
      if (k === 'event') e.event = v.join(': ');
      if (k === 'id') e.id = v.join(': ');
      if (k === 'data') e.data = v.join(': ');
    }
    return e;
  });
}

test('without credentials only /healthz answers; the API says 401 and / goes to login', async (t) => {
  const h = harness(t);
  assert.equal((await h.call('GET', '/healthz')).status, 200);
  const res = await h.call('GET', '/api/projects');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await h.call('GET', '/')).headers.get('location'), '/auth/login');
  assert.equal((await h.call('GET', '/api/nope', { as: 'read' })).status, 404);
});

test('a bad bearer token is refused, even next to a valid session cookie', async (t) => {
  const h = harness(t);
  const { cookie } = await login(h);
  const res = await h.app.request('/api/projects', { headers: { authorization: 'Bearer vs_nope', cookie } });
  assert.equal(res.status, 401);
  assert.equal((await h.app.request('/api/projects', { headers: { authorization: 'Basic abc' } })).status, 401);
});

test('each scope is refused on routes above it', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  h.projects.create(h.ctx, imageProject());

  const routes: Array<[string, string, 'read' | 'deploy' | 'admin', unknown?]> = [
    ['GET', '/api/projects', 'read'],
    ['GET', '/api/projects/hello', 'read'],
    ['GET', '/api/projects/hello/env', 'read'],
    ['GET', '/api/projects/hello/deploys', 'read'],
    ['GET', '/api/projects/hello/drift', 'read'],
    ['GET', '/api/registries', 'read'],
    ['GET', '/api/settings', 'read'],
    ['POST', '/api/projects', 'deploy', imageProject({ name: 'other' })],
    ['PATCH', '/api/projects/hello', 'deploy', { healthPath: '/up' }],
    ['PUT', '/api/projects/hello/env', 'deploy', [{ key: 'A', value: '1' }]],
    ['POST', '/api/projects/hello/deploy', 'deploy', {}],
    ['POST', '/api/projects/hello/webhook', 'admin'],
    ['GET', '/api/tokens', 'admin'],
    ['POST', '/api/tokens', 'admin', { name: 'x', scope: 'read' }],
    ['POST', '/api/registries', 'admin', { name: 'local', url: 'http://localhost:5050' }],
    ['PATCH', '/api/registries/1', 'admin', { name: 'local-renamed' }],
    ['PUT', '/api/settings/health_timeout_seconds', 'admin', { value: 30 }],
    ['GET', '/api/audit', 'admin'],
  ];
  const levels = ['read', 'deploy', 'admin'] as const;
  for (const [method, path, needed, body] of routes) {
    for (const scope of levels) {
      const res = await h.call(method, path, { as: scope, body });
      const allowed = levels.indexOf(scope) >= levels.indexOf(needed);
      // Repeating a create gives 409, which still means the scope check passed.
      if (allowed) assert.ok(res.status < 400 || res.status === 409, `${scope} ${method} ${path}: ${res.status} ${await res.text()}`);
      else assert.equal(res.status, 403, `${scope} ${method} ${path}`);
    }
  }
  await h.queue.idle();

  // Delete last, since it removes the project.
  assert.equal((await h.call('DELETE', '/api/projects/other', { as: 'deploy' })).status, 403);
  const del = await h.call('DELETE', '/api/projects/other', { as: 'admin' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { deleted: 'other', dataDeleted: false });
});

test('login with the provider starts a session that works as admin, and logout ends it', async (t) => {
  const h = harness(t);
  const { cookie, location } = await login(h, '/api/me');
  assert.equal(location, '/api/me');
  const me = await (await h.call('GET', '/api/me', { cookie })).json() as { kind: string; scope: string; user: { email: string } };
  assert.deepEqual([me.kind, me.scope, me.user.email], ['user', 'admin', 'admin@example.com']);
  // The session opens the dashboard, whose topbar has only the log out button.
  const home = await h.call('GET', '/', { cookie });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /action="\/auth\/logout"/);

  const out = await h.call('POST', '/auth/logout', { cookie, headers: { origin: ORIGIN } });
  assert.equal(out.status, 303);
  assert.equal((await h.call('GET', '/api/me', { cookie })).status, 401);
  const actions = h.audit.list().map((e) => e.action);
  assert.ok(actions.includes('auth.login') && actions.includes('auth.logout'));
});

test('the login page only shows a button; the flow starts when it is pressed', async (t) => {
  const h = harness(t);
  const res = await h.call('GET', '/auth/login?returnTo=%2Fprojects%2Fnew');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(await res.text(), /href="\/auth\/start\?returnTo=%2Fprojects%2Fnew"/);
  assert.match(await (await h.call('GET', '/auth/login?returnTo=//evil.example.com')).text(), /href="\/auth\/start"/);

  const { cookie } = await login(h);
  const already = await h.call('GET', '/auth/login?returnTo=%2Fsettings', { cookie });
  assert.equal(already.status, 302);
  assert.equal(already.headers.get('location'), '/settings');
});

test('the callback refuses a missing login cookie, a wrong state and an open redirect', async (t) => {
  const h = harness(t);
  assert.equal((await h.call('GET', '/auth/callback?code=good&state=x')).status, 400);

  const start = await h.call('GET', '/auth/start?returnTo=//evil.example.com');
  const loginCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await h.call('GET', '/auth/callback?code=good&state=wrong', { cookie: loginCookie })).status, 400);
  assert.equal((await h.call('GET', '/auth/callback?error=access_denied', { cookie: loginCookie })).status, 400);

  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const bad = await h.call('GET', `/auth/callback?code=bad&state=${state}`, { cookie: loginCookie });
  t.mock.method(console, 'error', () => {});
  assert.equal(bad.status, 502);
  const ok = await h.call('GET', `/auth/callback?code=good&state=${state}`, { cookie: loginCookie });
  assert.equal(ok.headers.get('location'), '/');
});

test('without OIDC settings, login says so and tokens still work', async (t) => {
  const h = harness(t, { oidc: null });
  assert.equal((await h.call('GET', '/auth/login')).status, 503);
  assert.equal((await h.call('GET', '/auth/start')).status, 503);
  assert.equal((await h.call('GET', '/api/projects', { as: 'read' })).status, 200);
});

test('cookie-authenticated writes must come from Vibeship itself', async (t) => {
  const h = harness(t);
  const { cookie } = await login(h);
  const body = imageProject();
  // An app on a sibling subdomain is same-site, so the cookie would be sent.
  const evil = await h.call('POST', '/api/projects', { cookie, body, headers: { origin: 'http://evil.localhost:8080' } });
  assert.equal(evil.status, 403);
  assert.equal((await h.call('POST', '/api/projects', { cookie, body })).status, 403);
  assert.equal((await h.call('POST', '/api/projects', { cookie, body, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await h.call('POST', '/auth/logout', { cookie, headers: { origin: 'http://evil.localhost:8080' } })).status, 403);

  const ok = await h.call('POST', '/api/projects', { cookie, body, headers: { origin: ORIGIN } });
  assert.equal(ok.status, 201);
  const d = await h.call('POST', '/api/projects/hello/deploy', { cookie, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(((await d.json()) as { trigger: string }).trigger, 'ui');
  await h.queue.idle();
});

test('the webhook deploys a digest, and a rotated URL is 404 for the old token', async (t) => {
  const h = harness(t);
  const v1 = h.fakeDocker.push(REF, 'healthy');
  const v2 = h.fakeDocker.push('localhost:5050/library/hello:v2', 'healthy');
  h.projects.create(h.ctx, imageProject());

  const gen = await h.call('POST', '/api/projects/hello/webhook', { as: 'admin' });
  assert.equal(gen.status, 201);
  const { url } = await gen.json() as { url: string };
  assert.match(url, /^http:\/\/vibeship\.localhost:8080\/hooks\/deploy\/[A-Za-z0-9_-]{43}$/);
  const path = new URL(url).pathname;

  const res = await h.call('POST', path, { body: { digest: v1, image: 'localhost:5050/library/hello:main' } });
  assert.equal(res.status, 202);
  const { deploy } = await res.json() as { deploy: { id: number } };
  await h.queue.idle();
  const d = h.deploys.get(deploy.id);
  assert.deepEqual([d.status, d.trigger, d.digest], ['healthy', 'webhook', v1]);

  assert.equal((await h.call('POST', path, { body: { digest: v2, image: 'localhost:5050/library/other' } })).status, 400);
  assert.equal((await h.call('POST', path, { body: { digest: 'latest' } })).status, 400);
  assert.equal((await h.app.request(path, { method: 'POST', body: 'not json' })).status, 400);

  // A digest from another repository fails at the pull and leaves v1 serving.
  const foreign = h.fakeDocker.push('localhost:5050/library/other:latest', 'healthy');
  const f = await (await h.call('POST', path, { body: { digest: foreign } })).json() as { deploy: { id: number } };
  await h.queue.idle();
  assert.equal(h.deploys.get(f.deploy.id).status, 'failed');
  assert.equal(h.fakeDocker.runningDigest('hello'), v1);

  await h.call('POST', '/api/projects/hello/webhook', { as: 'admin' });
  assert.equal((await h.call('POST', path, { body: { digest: v2 } })).status, 404);
  assert.equal((await h.call('POST', '/hooks/deploy/made-up', { body: { digest: v2 } })).status, 404);

  h.projects.create(h.ctx, composeProject());
  assert.equal((await h.call('POST', '/api/projects/blog/webhook', { as: 'admin' })).status, 400);
});

test('deploy logs come as JSON or as server-sent events ending with the outcome', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  h.projects.create(h.ctx, imageProject());
  const res = await h.call('POST', '/api/projects/hello/deploy', { as: 'deploy' });
  assert.equal(res.status, 202);
  const d = await res.json() as { id: number; trigger: string };
  assert.equal(d.trigger, 'api');

  // Streaming while the deploy runs: the stream waits for it and ends with `done`.
  const streamed = await h.call('GET', `/api/deploys/${d.id}/logs`, { as: 'read', headers: { accept: 'text/event-stream' } });
  assert.match(streamed.headers.get('content-type')!, /text\/event-stream/);
  const events = sse(await streamed.text());
  const done = events.at(-1)!;
  assert.equal(done.event, 'done');
  assert.deepEqual(JSON.parse(done.data), { status: 'healthy', failureReason: null });
  const logs = events.filter((e) => e.event === 'log');
  assert.ok(logs.length > 3);
  assert.deepEqual(logs.map((e) => Number(e.id)), logs.map((_, i) => i + 1));
  assert.equal((await (await h.call('GET', `/api/deploys/${d.id}`, { as: 'read' })).json() as { status: string }).status, 'healthy');

  const json = await (await h.call('GET', `/api/deploys/${d.id}/logs?after=2`, { as: 'read' })).json() as Array<{ seq: number }>;
  assert.equal(json[0]!.seq, 3);
  const resumed = await h.call('GET', `/api/deploys/${d.id}/logs`, { as: 'read', headers: { accept: 'text/event-stream', 'last-event-id': '3' } });
  assert.equal(sse(await resumed.text())[0]!.id, '4');

  assert.equal((await h.call('GET', '/api/deploys/999/logs', { as: 'read' })).status, 404);
  assert.equal((await h.call('GET', '/api/deploys/abc', { as: 'read' })).status, 404);
});

test('container logs come as JSON or as a stream', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const p = h.projects.create(h.ctx, imageProject());
  assert.equal((await h.call('GET', '/api/projects/hello/logs', { as: 'read' })).status, 404);

  h.deploys.request(h.ctx, p.id, {}, 'api');
  await h.queue.idle();
  h.fakeDocker.logLines.set('hello', [
    { stream: 'stdout', line: 'one' },
    { stream: 'stderr', line: 'two' },
    { stream: 'stdout', line: 'three' },
  ]);
  const json = await (await h.call('GET', '/api/projects/hello/logs?tail=2', { as: 'read' })).json();
  assert.deepEqual(json, [{ stream: 'stderr', line: 'two' }, { stream: 'stdout', line: 'three' }]);

  const streamed = await h.call('GET', `/api/projects/${p.id}/logs?follow=false`, { as: 'read', headers: { accept: 'text/event-stream' } });
  const events = sse(await streamed.text());
  assert.deepEqual(events.map((e) => e.event), ['log', 'log', 'log', 'end']);
  assert.deepEqual(JSON.parse(events[0]!.data), { stream: 'stdout', line: 'one' });
});

test('env secrets are write-only through the API, and changes are audited with the token', async (t) => {
  const h = harness(t);
  h.projects.create(h.ctx, imageProject());
  const put = await h.call('PUT', '/api/projects/hello/env', { as: 'deploy', body: [{ key: 'PUBLIC', value: 'p' }, { key: 'SECRET', value: 's3cret', secret: true }] });
  assert.equal(put.status, 200);
  const text = await (await h.call('GET', '/api/projects/hello/env', { as: 'read' })).text();
  assert.doesNotMatch(text, /s3cret/);
  assert.deepEqual((JSON.parse(text) as Array<{ key: string; value: string | null }>).map((e) => [e.key, e.value]), [['PUBLIC', 'p'], ['SECRET', null]]);

  const entry = h.audit.list().find((e) => e.action === 'env.replace')!;
  assert.equal(entry.actorType, 'token');
  assert.ok(entry.tokenId);

  const bad = await h.call('PUT', '/api/projects/hello/env', { as: 'deploy', body: [{ key: '1BAD', value: 'x' }] });
  assert.equal(bad.status, 400);
  assert.equal((await h.app.request('/api/projects/hello/env', { method: 'PUT', headers: { authorization: `Bearer ${h.tokens.deploy}` }, body: '[]' })).status, 400);
});

test('tokens can be created, listed and revoked through the API, and the new one works', async (t) => {
  const h = harness(t);
  const created = await (await h.call('POST', '/api/tokens', { as: 'admin', body: { name: 'agent', scope: 'deploy' } })).json() as { token: string; apiToken: { id: number } };
  const list = await (await h.call('GET', '/api/tokens', { as: 'admin' })).text();
  assert.doesNotMatch(list, new RegExp(created.token));
  const use = () => h.app.request('/api/projects', { headers: { authorization: `Bearer ${created.token}` } });
  assert.equal((await use()).status, 200);
  assert.equal((await h.call('DELETE', `/api/tokens/${created.apiToken.id}`, { as: 'admin' })).status, 200);
  assert.equal((await use()).status, 401);
});

test('compose versions through the API: saved with deploy scope, refused naming the key, then deployed', async (t) => {
  const h = harness(t);
  h.fakeDocker.push('nginx:1.29', 'healthy');
  const created = await h.call('POST', '/api/projects', { as: 'deploy', body: composeProject() });
  assert.equal(created.status, 201);

  const evil = await h.call('POST', '/api/projects/blog/compose', {
    as: 'deploy',
    body: { composeYaml: 'services:\n  app:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n', routedService: 'app', port: 80 },
  });
  assert.equal(evil.status, 400);
  const err = (await evil.json() as { error: { message: string; path: string } }).error;
  assert.equal(err.path, 'services.app.volumes[0]');
  assert.match(err.message, /services\.app\.volumes\[0\]: bind mounts may only use \.\/data/);

  const body = { composeYaml: composeProject().composeYaml, routedService: 'app', port: 80, note: 'v2' };
  assert.equal((await h.call('POST', '/api/projects/blog/compose', { as: 'read', body })).status, 403);
  const v2 = await h.call('POST', '/api/projects/blog/compose', { as: 'deploy', body });
  assert.equal(v2.status, 201);
  assert.equal((await v2.json() as { version: number }).version, 2);
  const list = await (await h.call('GET', '/api/projects/blog/compose', { as: 'read' })).json() as Array<{ version: number }>;
  assert.deepEqual(list.map((v) => v.version), [2, 1]);
  const one = await (await h.call('GET', '/api/projects/blog/compose/1', { as: 'read' })).json() as { composeYaml: string };
  assert.equal(one.composeYaml, composeProject().composeYaml);
  assert.equal((await h.call('GET', '/api/projects/blog/compose/9', { as: 'read' })).status, 404);

  const d = await (await h.call('POST', '/api/projects/blog/deploy', { as: 'deploy', body: { composeVersion: 1 } })).json() as { id: number };
  await h.queue.idle();
  assert.equal(h.deploys.get(d.id).status, 'healthy');
  assert.equal(h.deploys.get(d.id).composeVersionId, h.projects.getComposeVersion(h.projects.getByName('blog').id, 1).id);

  h.fakeDocker.logLines.set('blog-blog-1', [{ stream: 'stdout', line: 'compose app up' }]);
  assert.deepEqual(await (await h.call('GET', '/api/projects/blog/logs', { as: 'read' })).json(), [{ stream: 'stdout', line: 'compose app up' }]);
});
