// Integration tests: real Docker, Caddy and registry on the dev stack.
//
//   npm run dev        # in another terminal, or `scripts/dev.sh up -d`
//   npm run fixtures   # once, to build and push the fixture images
//   npm run test:integration
//
// They mint an admin token with src/token-cli.ts inside the container, then
// drive Vibeship only through its HTTP API and webhook, via Caddy on
// 127.0.0.1:8080, and check the apps through Caddy too.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = new URL('../../', import.meta.url).pathname;
const fixtures = JSON.parse(readFileSync(`${ROOT}.dev/fixtures.json`, 'utf8')) as Record<string, string>;
const REPO = fixtures.repository!;
const HELLO = 'it-hello';
const PROBE = 'it-probe';
const TWO = ['it-two-a', 'it-two-b'] as const;
const PROJECTS = [HELLO, PROBE, ...TWO];
const VIBESHIP = 'vibeship.localhost';

type Deploy = { id: number; status: string; trigger: string; digest: string | null; failureReason: string | null };
type Project = { id: number; status: string; image: { currentDigest: string | null } };
type Res = { status: number; body: string; json: <T>() => T };

/** An HTTP request through Caddy with the given Host header. */
function http(
  host: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...opts.headers, host };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    // A fresh connection each time: Caddy closes idle keep-alive connections
    // whenever its config reloads (every route change), which would make a
    // reused socket hang up.
    const req = request({ host: '127.0.0.1', port: 8080, method, path, headers, agent: false, timeout: opts.timeoutMs ?? 10_000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, json: <T>() => JSON.parse(body) as T }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end(payload);
  });
}

let admin = '';

/** Calls the API as admin (or with `token`) and returns the JSON body, failing on an error status. */
async function api<T>(method: string, path: string, body?: unknown, token = admin): Promise<T> {
  const res = await http(VIBESHIP, method, `/api${path}`, { token, body });
  assert.ok(res.status < 400, `${method} ${path}: ${res.status} ${res.body}`);
  return res.json<T>();
}

async function apiMaybe(method: string, path: string, body?: unknown): Promise<void> {
  await http(VIBESHIP, method, `/api${path}`, { token: admin, body }).catch(() => {});
}

/** Follows a deploy's server-sent log stream until it ends with `done`, then returns the deploy. */
async function wait(id: number): Promise<Deploy> {
  const res = await http(VIBESHIP, 'GET', `/api/deploys/${id}/logs`, {
    token: admin,
    timeoutMs: 180_000,
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /event: done\n/);
  const d = await api<Deploy>('GET', `/deploys/${id}`);
  assert.ok(d.status === 'healthy' || d.status === 'failed', `deploy ${id} is ${d.status} after its stream ended`);
  return d;
}

async function deploy(name: string, digest?: string): Promise<Deploy> {
  return api<Deploy>('POST', `/projects/${name}/deploy`, digest ? { digest } : {});
}

async function until<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

const helloBody = async () => (await http(`${HELLO}.localhost`, 'GET', '/')).body.trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const devExec = (...args: string[]) =>
  execFileSync(`${ROOT}scripts/dev.sh`, ['exec', '-T', 'vibeship', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(async () => {
  const health = await http(VIBESHIP, 'GET', '/healthz').catch(() => null);
  assert.equal(health?.status, 200, 'The dev stack is not running: start it with `npm run dev`');
  admin = devExec('node', 'src/token-cli.ts', 'integration-tests', 'admin');
  for (const p of PROJECTS) await apiMaybe('DELETE', `/projects/${p}?deleteData=true`);
  await apiMaybe('POST', '/registries', { name: 'local', url: 'http://localhost:5050' });
  await api('PUT', '/settings/health_timeout_seconds', { value: 15 });
});

after(async () => {
  for (const p of PROJECTS) await apiMaybe('DELETE', `/projects/${p}?deleteData=true`);
});

test('the API needs a token, and each scope is refused above its level', async () => {
  assert.equal((await http(VIBESHIP, 'GET', '/api/projects')).status, 401);
  assert.equal((await http(VIBESHIP, 'GET', '/api/projects', { token: 'vs_wrong' })).status, 401);
  const read = (await api<{ token: string }>('POST', '/tokens', { name: 'it-read', scope: 'read' })).token;
  const dep = (await api<{ token: string }>('POST', '/tokens', { name: 'it-deploy', scope: 'deploy' })).token;
  assert.equal((await http(VIBESHIP, 'GET', '/api/projects', { token: read })).status, 200);
  assert.equal((await http(VIBESHIP, 'POST', '/api/projects', { token: read, body: {} })).status, 403);
  assert.equal((await http(VIBESHIP, 'DELETE', '/api/projects/nothing', { token: dep })).status, 403);
  assert.equal((await http(VIBESHIP, 'GET', '/api/tokens', { token: dep })).status, 403);
});

test('hello deploys through scripts/webhook.sh and answers at its own hostname', async () => {
  await api('POST', '/projects', { kind: 'image', name: HELLO, imageRef: `${REPO}:hello`, containerPort: 8080, healthPath: '/health' });
  const { url } = await api<{ url: string }>('POST', `/projects/${HELLO}/webhook`);
  const out = execFileSync(`${ROOT}scripts/webhook.sh`, [url, `${REPO}:hello`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { deploy: queued } = JSON.parse(out) as { deploy: { id: number } };
  const d = await wait(queued.id);
  assert.equal(d.status, 'healthy', d.failureReason ?? '');
  assert.equal(d.trigger, 'webhook');
  assert.equal(d.digest, fixtures.hello);
  assert.equal(await helloBody(), 'hello from v1 (hello)');
  assert.equal((await http('nothing-here.localhost', 'GET', '/')).status, 404);
});

test('a rotated webhook URL returns 404 for the old token, and webhook paths stay out of the access log', async () => {
  const old = await api<{ url: string }>('POST', `/projects/${HELLO}/webhook`);
  const fresh = await api<{ url: string }>('POST', `/projects/${HELLO}/webhook`);
  const body = { digest: fixtures.hello };
  assert.equal((await http(VIBESHIP, 'POST', new URL(old.url).pathname, { body })).status, 404);
  const ok = await http(VIBESHIP, 'POST', new URL(fresh.url).pathname, { body });
  assert.equal(ok.status, 202);
  await wait(ok.json<{ deploy: { id: number } }>().deploy.id);

  // Caddy logs to stderr.
  const caddyLog = execFileSync('sh', ['-c', 'docker logs --since 5m vibeship-dev-caddy-1 2>&1'], { encoding: 'utf8' });
  assert.match(caddyLog, /"uri":"\/api\//, 'access logging should be on');
  assert.doesNotMatch(caddyLog, /\/hooks\//);
});

test('env values reach the container exactly, quotes, dollars and newlines included', async () => {
  const tricky = 'a"b\\c $HOME ${PATH} it\'s\nsecond line';
  await api('PUT', `/projects/${HELLO}/env`, [{ key: 'TRICKY', value: tricky, secret: true }]);
  assert.equal((await wait((await deploy(HELLO)).id)).status, 'healthy');
  const res = await http(`${HELLO}.localhost`, 'GET', '/env/TRICKY');
  assert.deepEqual(JSON.parse(res.body), { value: tricky });
  const listed = await api<Array<{ key: string; value: string | null }>>('GET', `/projects/${HELLO}/env`);
  assert.deepEqual(listed, [{ ...listed[0]!, key: 'TRICKY', value: null }]);
});

for (const broken of ['crash', 'unhealthy'] as const) {
  test(`deploying ${broken} over hello brings hello back`, async () => {
    const d = await wait((await deploy(HELLO, fixtures[broken])).id);
    assert.equal(d.status, 'failed');
    assert.match(d.failureReason!, broken === 'crash' ? /exited|crashed/ : /timed out/);
    const p = await api<Project>('GET', `/projects/${HELLO}`);
    assert.equal(p.status, 'running');
    assert.equal(p.image.currentDigest, fixtures.hello);
    assert.equal(await helloBody(), 'hello from v1 (hello)');
  });
}

test('a restart mid-deploy marks the deploy failed and brings back the last healthy version', async () => {
  const d = await deploy(HELLO, fixtures.slow);
  // Wait until the slow image is up and being health checked, then kill Vibeship.
  await until('the slow deploy to reach its health check', async () => {
    const logs = await api<Array<{ line: string }>>('GET', `/deploys/${d.id}/logs`);
    return logs.some((l) => l.line.startsWith('Waiting up to')) || undefined;
  });
  docker('kill', 'vibeship-dev-vibeship-1');
  execFileSync(`${ROOT}scripts/dev.sh`, ['up', '-d', 'vibeship'], { cwd: ROOT, stdio: 'ignore' });
  await until('Vibeship to come back', async () => (await http(VIBESHIP, 'GET', '/healthz')).status === 200 || undefined);

  const recovered = await until('the recovery deploy to finish', async () => {
    const r = (await api<Deploy[]>('GET', `/projects/${HELLO}/deploys`)).find((x) => x.trigger === 'recovery' && x.id > d.id);
    return r && r.status !== 'queued' && r.status !== 'running' ? r : undefined;
  });
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.digest, fixtures.hello);
  const interrupted = await api<Deploy>('GET', `/deploys/${d.id}`);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.failureReason, 'interrupted by restart');
  assert.equal(await helloBody(), 'hello from v1 (hello)');
});

test('a good new version goes live, and its container logs can be read', async () => {
  const d = await wait((await deploy(HELLO, fixtures['hello-v2'])).id);
  assert.equal(d.status, 'healthy');
  assert.equal(await helloBody(), 'hello from v2 (hello)');
  const logs = await api<Array<{ line: string }>>('GET', `/projects/${HELLO}/logs?tail=20`);
  assert.ok(logs.some((l) => l.line.includes('fixture hello v2 listening')), JSON.stringify(logs));
});

test('an app cannot reach the Caddy admin API, nor the Vibeship API without a token', async () => {
  await api('POST', '/projects', { kind: 'image', name: PROBE, imageRef: `${REPO}:probe`, containerPort: 8080, healthPath: '/health' });
  assert.equal((await wait((await deploy(PROBE)).id)).status, 'healthy');
  const results = JSON.parse((await http(`${PROBE}.localhost`, 'GET', '/')).body) as Record<string, string>;
  for (const target of ['caddy-api:2019', 'caddy:2019', '172.31.250.2:2019']) {
    assert.doesNotMatch(results[target]!, /^reachable/, `${target}: ${results[target]}`);
  }
  assert.equal(results['vibeship:3000/api'], 'reachable: HTTP 401');
});

test('a restarted Caddy gets every route back', async () => {
  docker('restart', 'vibeship-dev-caddy-1');
  await until('the hello route to come back', async () => ((await helloBody()) === 'hello from v2 (hello)' ? true : undefined), 30_000);
  assert.equal((await http(`${PROBE}.localhost`, 'GET', '/health')).status, 200);
});

test('drift: a hand edit is flagged until the next deploy rewrites the file', async () => {
  const compose = `${ROOT}.dev/stack/${HELLO}/compose.yaml`;
  execFileSync('sh', ['-c', `echo '# hand edit' >> ${compose}`]);
  type Drift = { files: Array<{ path: string; state: string }> };
  const drift = (await api<Drift>('GET', `/projects/${HELLO}/drift`)).files;
  assert.deepEqual(drift.find((f) => f.path === 'compose.yaml')?.state, 'modified');
  await wait((await deploy(HELLO)).id);
  const after = (await api<Drift>('GET', `/projects/${HELLO}/drift`)).files;
  assert.ok(after.every((f) => f.state === 'ok'));
});

// Compose projects

const twoApps = readFileSync(`${ROOT}examples/compose-two-apps/compose.yaml`, 'utf8').replaceAll('localhost:5050/fixtures/app', REPO);
const body = async (host: string, path = '/') => (await http(`${host}.localhost`, 'GET', path)).body.trim();

test('malicious compose YAML is refused with the offending key named', async () => {
  const res = await http(VIBESHIP, 'POST', '/api/projects', {
    token: admin,
    body: { kind: 'compose', name: TWO[0], routedService: 'app', port: 8080, composeYaml: 'services:\n  app:\n    image: alpine\n    privileged: true\n' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json<{ error: { message: string } }>().error.message, /^services\.app\.privileged: is not allowed/);
  assert.equal((await http(VIBESHIP, 'GET', `/api/projects/${TWO[0]}`, { token: admin })).status, 404);
});

test('two compose projects with the same service names each route to their own app and db', async () => {
  for (const [i, name] of TWO.entries()) {
    await api('POST', '/projects', { kind: 'compose', name, composeYaml: twoApps, routedService: 'app', port: 8080, healthPath: '/health' });
    await api('PUT', `/projects/${name}/env`, [{ key: 'DB_LABEL', value: `db-${'ab'[i]}` }]);
    const d = await wait((await deploy(name)).id);
    assert.equal(d.status, 'healthy', d.failureReason ?? '');
  }
  assert.equal(await body(TWO[0]), 'relay -> hello from db-a (hello)');
  assert.equal(await body(TWO[1]), 'relay -> hello from db-b (hello)');
  assert.equal((await api<{ deployedComposeVersion: number }>('GET', `/projects/${TWO[0]}`)).deployedComposeVersion, 1);
});

test('a broken compose version brings back the last healthy one', async () => {
  const broken = twoApps.replace('MODE: relay', 'MODE: crash');
  const v = await api<{ version: number }>('POST', `/projects/${TWO[0]}/compose`, { composeYaml: broken, routedService: 'app', port: 8080, healthPath: '/health', note: 'broken' });
  assert.equal(v.version, 2);
  const d = await wait((await deploy(TWO[0])).id);
  assert.equal(d.status, 'failed');
  const p = await api<{ status: string; deployedComposeVersion: number }>('GET', `/projects/${TWO[0]}`);
  assert.deepEqual([p.status, p.deployedComposeVersion], ['running', 1]);
  assert.equal(await body(TWO[0]), 'relay -> hello from db-a (hello)');
});

test('a compose app cannot read Vibeship secrets through interpolation, nor reach another project\'s db', async () => {
  const nosy = twoApps
    .replace('RELAY_URL: http://db:8080/', `RELAY_URL: http://${TWO[1]}-db-1:8080/\n      LEAK: \${MASTER_KEY:-unset}`);
  await api('POST', `/projects/${TWO[0]}/compose`, { composeYaml: nosy, routedService: 'app', port: 8080, healthPath: '/health' });
  assert.equal((await wait((await deploy(TWO[0])).id)).status, 'healthy');
  assert.equal(JSON.parse(await body(TWO[0], '/env/LEAK')).value, 'unset');
  assert.match(await body(TWO[0]), /^relay failed: (ENOTFOUND|EAI_AGAIN)/);
});
