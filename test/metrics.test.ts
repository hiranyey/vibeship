import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import { parsePair, parseSize } from '../src/docker/cli-runner.ts';
import { HostMonitor } from '../src/system/host.ts';
import { FakeHost } from './fakes.ts';
import { composeProject, imageProject, setup } from './helpers.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

test('docker stats sizes parse in decimal and binary units', () => {
  assert.equal(parseSize('512B'), 512);
  assert.equal(parseSize('1.5kB'), 1500);
  assert.equal(parseSize('12.5MiB'), 12.5 * MiB);
  assert.equal(parseSize('2GiB'), 2 * GiB);
  assert.equal(parseSize('--'), 0);
  assert.deepEqual(parsePair('64MiB / 7.6GiB'), [64 * MiB, Math.round(7.6 * GiB)]);
  assert.deepEqual(parsePair('1.2kB / 3kB'), [1200, 3000]);
});

test('the host monitor measures CPU between readings', async () => {
  const src = new FakeHost();
  src.cpuPercent = 40;
  const m = new HostMonitor({ source: src });
  const s = await m.sample();
  assert.equal(s.cpuPercent, 40);
  assert.equal(s.cores, 4);
  assert.equal(s.memTotalBytes, 8 * GiB);
  assert.equal(s.memUsedBytes, 2 * GiB);
  assert.equal(s.memPercent, 25);
  assert.deepEqual(await Promise.all([m.sample(), m.sample()]), [s, s], 'a recent sample is reused');
});

test('usage is summed per project and shared out against the VM', async (t) => {
  const s = setup(t);
  const a = s.fakeDocker.push('localhost:5050/library/hello:latest', 'healthy');
  s.fakeDocker.push('nginx:1.29', 'healthy');
  const hello = s.projects.create(s.ctx, imageProject());
  const blog = s.projects.create(s.ctx, composeProject({ name: 'blog' }));
  s.deploys.request(s.ctx, hello.id, { digest: a }, 'api');
  s.deploys.request(s.ctx, blog.id, {}, 'api');
  await s.queue.idle();
  s.fakeDocker.stats.set('hello', { cpuPercent: 200, memBytes: 512 * MiB });
  // A container outside Vibeship's projects is not counted.
  s.fakeDocker.containers.set('stray', { image: 'x', behavior: 'healthy', project: 'not-ours' });

  const o = await s.metrics.overview();
  assert.equal(o.host.cores, 4);
  assert.equal(o.dockerError, null);
  assert.deepEqual(o.projects.map((p) => p.project), ['hello', 'blog'], 'busiest first');
  const h = o.projects[0]!;
  assert.equal(h.cpuShare, 50, 'two cores of four');
  assert.equal(h.memShare, 6.3);
  assert.equal(o.projects.some((p) => p.project === 'not-ours'), false);

  const pm = await s.metrics.project(hello.id);
  assert.equal(pm.usage.memBytes, 512 * MiB);
  assert.deepEqual(pm.containers.map((c) => [c.name, c.cpuShare]), [['hello', 50]]);
});

test('without Docker the host figures still come back, with the error', async (t) => {
  const s = setup(t);
  s.fakeDocker.statsError = 'Cannot connect to the Docker daemon';
  const o = await s.metrics.overview();
  assert.equal(o.dockerError, 'Cannot connect to the Docker daemon');
  assert.equal(o.host.memPercent, 25);
  assert.deepEqual(o.projects, []);
});

test('metrics over the API need a read token', async (t) => {
  const s = setup(t);
  const config = loadConfig({ PUBLIC_URL: 'http://vibeship.localhost:8080', STACK_ROOT: s.stackRoot, BASE_DOMAIN: 'localhost', MASTER_KEY: generateMasterKey() });
  const app = createApp({ config, db: s.db, services: s, oidc: null });
  s.projects.create(s.ctx, imageProject());
  const { token } = s.tokens.create(s.ctx, { name: 'r', scope: 'read' });
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await app.request('/api/metrics')).status, 401);
  const overview = await (await app.request('/api/metrics', { headers: auth })).json() as { host: { cores: number } };
  assert.equal(overview.host.cores, 4);
  const project = await (await app.request('/api/projects/hello/metrics', { headers: auth })).json() as { usage: { containers: number } };
  assert.equal(project.usage.containers, 0);
});
