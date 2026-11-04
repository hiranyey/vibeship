// The deploy guide states facts about the deploy code. These tests check
// each fact against what the code actually does, so changing one without the
// other fails here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';
import { CADDY_PUBLIC_PORT, caddyBaseConfig } from '../src/caddy/base-config.ts';
import {
  BIND_SOURCES, ENV_FILES, LOOPBACK, NO_INTERPOLATION_KEYS, SERVICE_KEYS, TOP_KEYS, checkCompose, renderComposeProject,
} from '../src/compose/validate.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import { DATA_DIR, ENV_FILE, ENV_FILE_MODE, IMAGE_DATA_MOUNT, WEB_NETWORK } from '../src/deploy/layout.ts';
import { renderImageCompose } from '../src/deploy/render.ts';
import { DIGEST_PATTERN } from '../src/schemas.ts';
import { HEALTH_TIMEOUT_SECONDS } from '../src/services/settings.ts';
import {
  REFUSED_SERVICE_KEYS_EXAMPLES, exampleCompose, exampleRepository, githubWorkflow, guideContext, renderDeployGuide, snapshotProject,
} from '../src/mcp/guide.ts';
import { FAST_TIMING, composeProject, imageProject, setup } from './helpers.ts';

const REF = 'localhost:5050/library/hello:latest';

function harness(t: TestContext) {
  const s = setup(t);
  const guide = (opts: Omit<Parameters<typeof renderDeployGuide>[0], 'ctx'> = {}) =>
    renderDeployGuide({ ctx: guideContext(s, 'localhost'), ...opts });
  return { ...s, guide };
}

const svc = (body: string) => `services:\n  app:\n    image: nginx:1.29\n${body}`;
const refusal = (yaml: string) => {
  try {
    checkCompose(yaml, 'app');
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

test('image projects: the data mount, env file and network the guide states are what the generated file uses', (t) => {
  const h = harness(t);
  const file = parse(renderImageCompose({ name: 'hello', imageRef: REF, digest: `sha256:${'a'.repeat(64)}`, memLimit: null }));
  const service = file.services.hello;
  assert.deepEqual(service.volumes, [`./${DATA_DIR}:${IMAGE_DATA_MOUNT}`]);
  assert.deepEqual(service.env_file, [ENV_FILE]);
  assert.deepEqual(Object.keys(service.networks), [WEB_NETWORK]);
  assert.deepEqual(service.networks[WEB_NETWORK].aliases, ['hello']);
  assert.equal(service.ports, undefined, 'image projects publish no ports');
  assert.equal(service.image, `localhost:5050/library/hello@sha256:${'a'.repeat(64)}`, 'pinned by digest');

  const text = h.guide({ kind: 'image' });
  assert.ok(text.includes(`\`./${DATA_DIR}:${IMAGE_DATA_MOUNT}\``));
  assert.ok(text.includes(`mounted read-write at \`${IMAGE_DATA_MOUNT}\``));
  assert.ok(text.includes(`\`env_file: [${ENV_FILE}]\``));
  assert.ok(text.includes(`over the \`${WEB_NETWORK}\` network`));
});

test('the host data folder, .env and what delete_project keeps match the guide', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const p = h.projects.create(h.ctx, imageProject({ name: 'hello', healthPath: null }));
  const d = h.deploys.request(h.ctx, p.id, {}, 'api');
  await h.queue.idle();
  assert.equal(h.deploys.get(d.id).status, 'healthy');

  const snap = snapshotProject(h, h.projects.get(p.id));
  assert.equal(snap.dataHostPath, join(h.stackRoot, 'hello', DATA_DIR));
  assert.ok(statSync(snap.dataHostPath).isDirectory(), 'the data folder the guide names exists after a deploy');
  assert.equal(statSync(join(h.stackRoot, 'hello', ENV_FILE)).mode & 0o777, ENV_FILE_MODE);
  assert.ok(h.guide({ project: snap }).includes(`\`${join(h.stackRoot, 'hello', ENV_FILE)}\` on the host, mode \`0600\``));

  // "data/ and named volumes are kept" unless deleteData.
  await h.deploys.removeProject(h.ctx, p.id);
  assert.ok(existsSync(join(h.stackRoot, 'hello', DATA_DIR)));
  assert.ok(!existsSync(join(h.stackRoot, 'hello', ENV_FILE)));
  assert.match(h.guide(), /are \*\*kept\*\*/);
});

test('every compose key the guide allows is accepted, and every key it names as refused is refused', (t) => {
  const h = harness(t);
  // One valid value per allowed service key; the set of keys must match the allowlist exactly.
  const samples: Record<string, string> = {
    image: '', // already in svc()
    command: '    command: ["node", "server.js"]\n',
    entrypoint: '    entrypoint: /bin/sh\n',
    environment: '    environment:\n      A: "1"\n',
    env_file: '    env_file: .env\n',
    ports: `    ports:\n      - "${LOOPBACK}:8080:80"\n`,
    volumes: '    volumes:\n      - ./data:/data\n',
    depends_on: '    depends_on: [db]\n',
    healthcheck: '    healthcheck:\n      test: ["CMD", "true"]\n',
    restart: '    restart: unless-stopped\n',
    working_dir: '    working_dir: /app\n',
    user: '    user: "1000"\n',
    labels: '    labels:\n      team: web\n',
    mem_limit: '    mem_limit: 512m\n',
    cpus: '    cpus: 0.5\n',
    networks: '    networks: [default]\n',
  };
  assert.deepEqual(Object.keys(samples).sort(), [...SERVICE_KEYS].sort(), 'the guide lists exactly the allowlist');
  const db = '  db:\n    image: postgres:17\n';
  for (const [key, body] of Object.entries(samples)) {
    assert.equal(refusal(svc(body) + db), null, `${key} is accepted as the guide says`);
  }
  for (const key of REFUSED_SERVICE_KEYS_EXAMPLES) {
    assert.match(refusal(svc(`    ${key}: x\n`)) ?? '', new RegExp(`^services\\.app\\.${key}: is not allowed`), `${key} is refused`);
  }
  for (const key of ['configs', 'secrets']) assert.match(refusal(`${svc('')}${key}: {}\n`) ?? '', /top-level key is not allowed/);

  // Bind mounts: exactly ./data, nothing inside it; $ refused where the guide says.
  for (const source of BIND_SOURCES) assert.equal(refusal(svc(`    volumes:\n      - ${source}:/x\n`)), null);
  for (const source of ['./data/sub', '/etc', '~/x', '../data']) assert.ok(refusal(svc(`    volumes:\n      - ${source}:/x\n`)), `${source} is refused`);
  for (const key of NO_INTERPOLATION_KEYS) {
    const value = key === 'ports' ? `      - "${LOOPBACK}:\${P}:80"\n` : key === 'volumes' ? '      - ${D}:/x\n' : '      - ${N}\n';
    assert.match(refusal(svc(`    ${key}:\n${value}`)) ?? '', /\$ \(variable interpolation\) is not allowed/, `$ refused in ${key}`);
  }
  for (const f of ENV_FILES) assert.equal(refusal(svc(`    env_file: ${f}\n`)), null);
  assert.ok(refusal(svc('    env_file: other.env\n')));
  assert.ok(refusal(svc('    ports:\n      - "0.0.0.0:80:80"\n')), 'ports on 0.0.0.0 are refused');
  assert.ok(refusal(svc('    ports:\n      - "80:80"\n')), 'ports without a host address are refused');
  assert.ok(refusal(svc(`    networks: [${WEB_NETWORK}]\n`)), `joining ${WEB_NETWORK} is refused`);

  const text = h.guide({ kind: 'compose' });
  for (const key of SERVICE_KEYS) assert.ok(text.includes(`\`${key}\``), `the guide names ${key}`);
  for (const key of TOP_KEYS) assert.ok(text.includes(`\`${key}\``));
});

test('the compose example in the guide is accepted, and only its routed service joins web', () => {
  const yaml = exampleCompose('shop');
  const rendered = parse(renderComposeProject(checkCompose(yaml, 'app'), 'shop'));
  assert.deepEqual(Object.keys(rendered.services).sort(), ['db', 'shop']);
  assert.ok(WEB_NETWORK in rendered.services.shop.networks);
  assert.equal(rendered.services.db.networks, undefined);
  assert.deepEqual(rendered.services.shop.env_file, [ENV_FILE]);
  assert.ok(rendered.services.shop.volumes.includes(`./${DATA_DIR}:/app/uploads`));
  assert.equal(rendered.services.shop.image, `${exampleRepository('shop')}:latest`);
});

test('health check facts: the timeout follows the setting, and the failure message is the one the guide quotes', async (t) => {
  const h = harness(t);
  assert.equal(h.settings.get('health_timeout_seconds'), HEALTH_TIMEOUT_SECONDS.default, 'the migration seeds the default the guide states');
  assert.throws(() => h.settings.set(h.ctx, 'health_timeout_seconds', HEALTH_TIMEOUT_SECONDS.min - 1));
  assert.throws(() => h.settings.set(h.ctx, 'health_timeout_seconds', HEALTH_TIMEOUT_SECONDS.max + 1));
  h.settings.set(h.ctx, 'health_timeout_seconds', 120);
  assert.match(h.guide(), /for up to \*\*120s\*\*/);

  // A deploy that never gets healthy fails with exactly the message the guide quotes.
  h.fakeDocker.push(REF, 'unhealthy');
  const p = h.projects.create(h.ctx, imageProject());
  const d = h.deploys.request(h.ctx, p.id, {}, 'api');
  await h.queue.idle();
  const reason = h.deploys.get(d.id).failureReason!;
  const fast = renderDeployGuide({ ctx: { ...guideContext(h, 'localhost'), healthTimeoutSeconds: FAST_TIMING.timeoutMs / 1000 }, kind: 'image' });
  const quoted = /`(health check timed out after [^`:]+s): <last problem>`/.exec(fast)![1]!;
  assert.ok(reason.startsWith(`${quoted}: http://hello:8080/health answered`), `${reason} starts with ${quoted}`);
  assert.ok(fast.includes('No earlier healthy version to bring back; stopping the broken containers'));
  assert.ok(h.deploys.logs(d.id).some((l) => l.line === 'No earlier healthy version to bring back; stopping the broken containers'));
});

test('env facts: COMPOSE_/DOCKER_ are the only reserved names, and changes wait for the next deploy', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const p = h.projects.create(h.ctx, imageProject({ healthPath: null }));
  for (const key of ['COMPOSE_FILE', 'docker_host']) assert.throws(() => h.env.set(h.ctx, p.id, { set: { [key]: { value: 'x' } } }), /reserved/);
  h.env.set(h.ctx, p.id, { set: { PORT: { value: '8080' }, DATA_DIR: { value: '/data' } } });

  await (async () => { h.deploys.request(h.ctx, p.id, {}, 'api'); await h.queue.idle(); })();
  const envPath = join(h.stackRoot, 'hello', ENV_FILE);
  const before = readFileSync(envPath, 'utf8');
  assert.match(before, /^PORT="8080"$/m, 'the only variables are the ones set');

  h.env.set(h.ctx, p.id, { set: { GREETING: { value: 'hi' } } });
  assert.equal(h.deploys.drift(p.id).pendingChanges, true);
  await h.deploys.lifecycle(h.ctx, p.id, 'restart');
  assert.equal(readFileSync(envPath, 'utf8'), before, 'restart does not apply env changes');

  // A deploy of the live digest applies them without changing version.
  const digest = h.projects.get(p.id).image!.currentDigest!;
  h.deploys.request(h.ctx, p.id, { digest }, 'api');
  await h.queue.idle();
  assert.match(readFileSync(envPath, 'utf8'), /^GREETING="hi"$/m);
  assert.equal(h.deploys.drift(p.id).pendingChanges, false);
});

test('dataOwner facts: the log line, failure reason and compose refusal the guide quotes are the real ones', async (t) => {
  let fail = false;
  const h = (() => {
    const s = setup(t, { lchown: () => { if (fail) throw new Error('EPERM: operation not permitted'); } });
    const guide = (opts: Omit<Parameters<typeof renderDeployGuide>[0], 'ctx'> = {}) => renderDeployGuide({ ctx: guideContext(s, 'localhost'), ...opts });
    return { ...s, guide };
  })();
  h.fakeDocker.push(REF, 'healthy');
  const p = h.projects.create(h.ctx, imageProject({ healthPath: null, dataOwner: '1000:1000' }));
  const ok = h.deploys.request(h.ctx, p.id, {}, 'api');
  await h.queue.idle();
  const image = h.guide({ kind: 'image' });
  const line = h.deploys.logs(ok.id).map((l) => l.line).find((l) => l.startsWith('Data folder owned by'));
  assert.equal(line, 'Data folder owned by 1000:1000');
  assert.ok(image.includes('`Data folder owned by <uid>:<gid>`'));

  fail = true;
  const bad = h.deploys.request(h.ctx, p.id, {}, 'api');
  await h.queue.idle();
  assert.match(h.deploys.get(bad.id).failureReason!, /^could not give data\/ to 1000:1000: /);
  assert.ok(image.includes('`could not give data/ to <uid>:<gid>: <reason>`'));
  assert.ok(image.includes('the running version keeps serving'));
  assert.equal(h.projects.get(p.id).status, 'running');

  // Persistent data explains it, and troubleshooting suggests it first.
  const data = image.slice(image.indexOf('## Persistent data'), image.indexOf('## Env vars'));
  for (const part of ['dataOwner: "1000:1000"', 'USER node', 'bind mount hides', 'setpriv', 'gosu', 'does not set `user:`']) {
    assert.ok(data.includes(part), `Persistent data mentions ${part}`);
  }
  const trouble = image.slice(image.indexOf('## Troubleshooting'));
  assert.ok(trouble.includes('First fix: `update_project { dataOwner: "1000:1000" }`'));

  let refusal = '';
  try { h.projects.create(h.ctx, composeProject({ dataOwner: '1000:1000' })); } catch (err) { refusal = (err as Error).message; }
  assert.ok(h.guide({ kind: 'compose' }).includes(`\`validation: ${refusal}\``), refusal);
  assert.ok(!h.guide({ kind: 'compose' }).includes('First fix: `update_project { dataOwner'), 'compose troubleshooting does not suggest it');

  const snap = h.guide({ project: snapshotProject(h, h.projects.get(p.id)) });
  assert.ok(snap.includes('data owner: `1000:1000` (applied on each deploy)'));
});

test('networking facts: default hostname, upstream and the public port', (t) => {
  const h = harness(t);
  const p = h.projects.create(h.ctx, composeProject({ port: 3000 }));
  assert.equal(p.hostname, 'blog.localhost');
  assert.equal(p.upstream, 'blog:3000');
  const snap = snapshotProject(h, p);
  assert.ok(h.guide({ project: snap }).includes('Caddy upstream: `blog:3000`'));
  assert.ok(h.guide().includes('The default is `<project>.localhost`'));

  for (const mode of ['origin-cert', 'off'] as const) {
    const config = caddyBaseConfig({ host: 'vibeship.localhost', tlsMode: mode, certFile: '/c', keyFile: '/k' }) as {
      apps: { http: { servers: Record<string, { listen: string[] }> } };
    };
    assert.deepEqual(Object.values(config.apps.http.servers)[0]!.listen, [`:${CADDY_PUBLIC_PORT[mode]}`]);
  }
  assert.ok(h.guide().includes(`port ${CADDY_PUBLIC_PORT['origin-cert']} in production`));
});

test('webhook facts: the responses the guide quotes are the ones the receiver sends', async (t) => {
  const h = harness(t);
  const config = loadConfig({ PUBLIC_URL: 'http://vibeship.localhost', STACK_ROOT: h.stackRoot, BASE_DOMAIN: 'localhost', MASTER_KEY: generateMasterKey() });
  const app = createApp({ config, db: h.db, services: h, oidc: null });
  const p = h.projects.create(h.ctx, imageProject());
  const { token } = h.projects.rotateWebhook(h.ctx, p.id);
  const post = async (body: string | undefined, path = `/hooks/deploy/${token}`) => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { status: res.status, message: ((await res.json()) as { error?: { message: string } }).error?.message };
  };
  const text = h.guide({ kind: 'image' });
  const quoted = (status: number, message: string) => {
    assert.ok(text.includes(`\`${status} ${message}\``) || text.includes(`\`${status}\` with \`${message}\``), `guide quotes ${status} ${message}`);
  };

  const noBody = await post(undefined);
  assert.equal(noBody.status, 400);
  quoted(400, noBody.message!);
  const badDigest = await post(JSON.stringify({ digest: 'sha256:abc' }));
  assert.equal(badDigest.message, 'digest: must be sha256:<64 hex characters>');
  quoted(400, badDigest.message!);
  const wrongImage = await post(JSON.stringify({ digest: `sha256:${'b'.repeat(64)}`, image: 'localhost:5050/library/other' }));
  assert.equal(wrongImage.message, 'image: this webhook deploys localhost:5050/library/hello, not localhost:5050/library/other');
  quoted(400, 'image: this webhook deploys <repository>, not <image>');
  const unknown = await post(JSON.stringify({ digest: `sha256:${'b'.repeat(64)}` }), '/hooks/deploy/nope');
  assert.deepEqual(unknown, { status: 404, message: 'Unknown webhook' });
  quoted(404, unknown.message!);
  const big = await post(JSON.stringify({ digest: `sha256:${'b'.repeat(64)}`, pad: 'x'.repeat(20_000) }));
  assert.deepEqual(big, { status: 400, message: 'The request body is too large' });
  quoted(400, big.message!);

  assert.ok(text.includes(DIGEST_PATTERN.source));
  assert.ok(githubWorkflow(exampleRepository('x')).includes(`=~ ${DIGEST_PATTERN.source} ]]`));
});

test('the example workflow is the one the guide generates, and it never prints the webhook URL', () => {
  const file = readFileSync(new URL('../examples/github-actions/deploy.yml', import.meta.url), 'utf8');
  assert.equal(file, githubWorkflow(exampleRepository('my-app')), 'regenerate examples/github-actions/deploy.yml from githubWorkflow');

  const wf = parse(file);
  const steps = wf.jobs.deploy.steps as Array<Record<string, any>>;
  const build = steps.find((s) => s.id === 'build')!;
  assert.deepEqual(build.with.tags.trim().split('\n'), ['${{ env.IMAGE }}:latest', '${{ env.IMAGE }}:${{ github.sha }}']);
  const login = steps.find((s) => s.uses?.startsWith('docker/login-action'))!;
  assert.equal(login.with.registry, 'api.repoflow.io');
  assert.equal(login.with.password, '${{ secrets.REPOFLOW_PASSWORD }}');
  const deploy = steps.find((s) => s.name === 'Deploy')!;
  assert.equal(deploy.env.WEBHOOK_URL, '${{ secrets.WEBHOOK_URL }}');
  assert.match(deploy.run, /curl -fsS --retry 3 .*"\$WEBHOOK_URL"$/m);
  for (const line of (deploy.run as string).split('\n').filter((l) => /\b(echo|printf)\b/.test(l))) {
    assert.doesNotMatch(line, /WEBHOOK_URL"?\s*(>|$|;)|echo[^"]*"\$WEBHOOK_URL/, `never echoes the URL: ${line}`);
  }
  assert.doesNotMatch(deploy.run, /set -x/);
});
