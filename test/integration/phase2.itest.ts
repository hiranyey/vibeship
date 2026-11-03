// Phase 2 integration tests: real Docker, Caddy and registry on the dev stack.
//
//   npm run dev        # in another terminal, or `scripts/dev.sh up -d`
//   npm run fixtures   # once, to build and push the fixture images
//   npm run test:integration
//
// They drive Vibeship through the temporary dev CLI inside the container
// (src/dev-cli.ts) and check the results through Caddy on 127.0.0.1:8080.
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

type Deploy = { id: number; status: string; trigger: string; digest: string | null; failureReason: string | null };
type Shown = { project: { status: string; image: { currentDigest: string | null } }; deploys: Deploy[] };

function cli<T>(...args: string[]): T {
  const out = execFileSync(`${ROOT}scripts/dev.sh`, ['exec', '-T', 'vibeship', 'node', 'src/dev-cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as T;
}

function cliMaybe(...args: string[]): void {
  try {
    cli(...args);
  } catch {
    // Already gone, or already exists.
  }
}

/** GET through Caddy with the given Host header. */
function get(host: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 8080, path, headers: { host }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
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

const helloBody = async () => (await get(`${HELLO}.localhost`)).body.trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

before(async () => {
  const health = await get('vibeship.localhost', '/healthz').catch(() => null);
  assert.equal(health?.status, 200, 'The dev stack is not running: start it with `npm run dev`');
  cliMaybe('remove', HELLO, '--delete-data');
  cliMaybe('remove', PROBE, '--delete-data');
  cliMaybe('registry-add', 'local', 'http://localhost:5050');
  cli('setting', 'health_timeout_seconds', '15');
});

after(() => {
  cliMaybe('remove', HELLO, '--delete-data');
  cliMaybe('remove', PROBE, '--delete-data');
});

test('hello deploys and answers at its own hostname', async () => {
  cli('create', HELLO, `${REPO}:hello`, '8080', '/health');
  const d = cli<Deploy>('deploy', HELLO, '--wait');
  assert.equal(d.status, 'healthy', d.failureReason ?? '');
  assert.equal(d.digest, fixtures.hello);
  assert.equal(await helloBody(), 'hello from v1 (hello)');
  assert.equal((await get('nothing-here.localhost')).status, 404);
});

test('env values reach the container exactly, quotes, dollars and newlines included', async () => {
  const tricky = 'a"b\\c $HOME ${PATH} it\'s\nsecond line';
  cli('env-set', HELLO, 'TRICKY', tricky, '--secret');
  assert.equal(cli<Deploy>('deploy', HELLO, '--wait').status, 'healthy');
  const res = await get(`${HELLO}.localhost`, '/env/TRICKY');
  assert.deepEqual(JSON.parse(res.body), { value: tricky });
});

for (const broken of ['crash', 'unhealthy'] as const) {
  test(`deploying ${broken} over hello brings hello back`, async () => {
    const d = cli<Deploy>('deploy', HELLO, fixtures[broken]!, '--wait');
    assert.equal(d.status, 'failed');
    assert.match(d.failureReason!, broken === 'crash' ? /exited|crashed/ : /timed out/);
    const shown = cli<Shown>('show', HELLO);
    assert.equal(shown.project.status, 'running');
    assert.equal(shown.project.image.currentDigest, fixtures.hello);
    assert.equal(await helloBody(), 'hello from v1 (hello)');
  });
}

test('a restart mid-deploy marks the deploy failed and brings back the last healthy version', async () => {
  const d = cli<Deploy>('deploy', HELLO, fixtures.slow!);
  // Wait until the slow image is up and being health checked, then kill Vibeship.
  await until('the slow deploy to reach its health check', () => {
    const logs = cli<Array<{ line: string }>>('logs', String(d.id));
    return logs.some((l) => l.line.startsWith('Waiting up to')) || undefined;
  });
  docker('kill', 'vibeship-dev-vibeship-1');
  execFileSync(`${ROOT}scripts/dev.sh`, ['up', '-d', 'vibeship'], { cwd: ROOT, stdio: 'ignore' });
  await until('Vibeship to come back', async () => (await get('vibeship.localhost', '/healthz')).status === 200 || undefined);

  const recovered = await until('the recovery deploy to finish', () => {
    const r = cli<Shown>('show', HELLO).deploys.find((x) => x.trigger === 'recovery' && x.id > d.id);
    return r && r.status !== 'queued' && r.status !== 'running' ? r : undefined;
  });
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.digest, fixtures.hello);
  const interrupted = cli<Shown>('show', HELLO).deploys.find((x) => x.id === d.id)!;
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.failureReason, 'interrupted by restart');
  assert.equal(await helloBody(), 'hello from v1 (hello)');
});

test('a good new version goes live', async () => {
  const d = cli<Deploy>('deploy', HELLO, fixtures['hello-v2']!, '--wait');
  assert.equal(d.status, 'healthy');
  assert.equal(await helloBody(), 'hello from v2 (hello)');
});

test('an app cannot reach the Caddy admin API', async () => {
  cli('create', PROBE, `${REPO}:probe`, '8080', '/health');
  assert.equal(cli<Deploy>('deploy', PROBE, '--wait').status, 'healthy');
  const results = JSON.parse((await get(`${PROBE}.localhost`)).body) as Record<string, string>;
  for (const target of ['caddy-api:2019', 'caddy:2019', '172.31.250.2:2019']) {
    assert.doesNotMatch(results[target]!, /^reachable/, `${target}: ${results[target]}`);
  }
});

test('a restarted Caddy gets every route back', async () => {
  docker('restart', 'vibeship-dev-caddy-1');
  await until('the hello route to come back', async () => ((await helloBody()) === 'hello from v2 (hello)' ? true : undefined), 30_000);
  assert.equal((await get(`${PROBE}.localhost`, '/health')).status, 200);
});

test('drift: a hand edit is flagged until the next deploy rewrites the file', async () => {
  const compose = `${ROOT}.dev/stack/${HELLO}/compose.yaml`;
  execFileSync('sh', ['-c', `echo '# hand edit' >> ${compose}`]);
  const drift = (cli<{ drift: { files: Array<{ path: string; state: string }> } }>('show', HELLO)).drift.files;
  assert.deepEqual(drift.find((f) => f.path === 'compose.yaml')?.state, 'modified');
  cli('deploy', HELLO, '--wait');
  const after = (cli<{ drift: { files: Array<{ path: string; state: string }> } }>('show', HELLO)).drift.files;
  assert.ok(after.every((f) => f.state === 'ok'));
});
