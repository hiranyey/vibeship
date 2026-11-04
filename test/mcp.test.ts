import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import type { TokenScope } from '../src/schemas.ts';
import { setup } from './helpers.ts';

const ORIGIN = 'http://vibeship.localhost:8080';
const REF = 'localhost:5050/library/hello:latest';
const SECRET = 'sup3r-s3cret-value';

function harness(t: TestContext) {
  const s = setup(t);
  const config = loadConfig({ PUBLIC_URL: ORIGIN, STACK_ROOT: s.stackRoot, BASE_DOMAIN: 'localhost', MASTER_KEY: generateMasterKey() });
  const app = createApp({ config, db: s.db, services: s, oidc: null });
  const clients: Client[] = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));

  /** An MCP client for a new token of the given scope, talking to the app in-process. */
  async function agent(scope: TokenScope) {
    const { token } = s.tokens.create(s.ctx, { name: `agent-${scope}`, scope });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.request(String(url), init),
    }));
    clients.push(client);
    /** Calls a tool and returns its parsed JSON, or the error text with `error` set. */
    const call = async <T = unknown>(name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      const text = r.content.map((c) => c.text).join('');
      return r.isError ? { error: text } as T & { error?: string } : JSON.parse(text) as T & { error?: string };
    };
    return { client, call };
  }
  return { ...s, app, agent };
}

const READ_TOOLS = ['get_container_logs', 'get_deploy_guide', 'get_deploy_logs', 'get_project', 'get_status', 'list_deploys', 'list_projects', 'list_registries'];
const DEPLOY_TOOLS = ['create_project', 'deploy', 'restart', 'set_env', 'start', 'stop', 'update_compose', 'update_project'];

test('/mcp takes only bearer API tokens, over POST', async (t) => {
  const h = harness(t);
  const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' };
  const none = await h.app.request('/mcp', init);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer');

  // A browser session is not enough, so a page can't drive MCP with the admin's cookie.
  const { token: session } = h.sessions.login({ sub: 's', email: 'a@example.com', name: null }, {});
  const cookie = await h.app.request('/mcp', { ...init, headers: { ...init.headers, cookie: `vs_session=${session}`, origin: ORIGIN } });
  assert.equal(cookie.status, 401);

  const { token } = h.tokens.create(h.ctx, { name: 'x', scope: 'read' });
  assert.equal((await h.app.request('/mcp', { headers: { authorization: `Bearer ${token}` } })).status, 405);
});

test('each scope lists only the tools it may use', async (t) => {
  const h = harness(t);
  const names = async (scope: TokenScope) => (await (await h.agent(scope)).client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(await names('read'), READ_TOOLS);
  assert.deepEqual(await names('deploy'), [...READ_TOOLS, ...DEPLOY_TOOLS].sort());
  assert.deepEqual(await names('admin'), [...READ_TOOLS, ...DEPLOY_TOOLS, 'delete_project', 'rotate_webhook'].sort());

  const { call } = await h.agent('read');
  assert.match((await call('create_project', { kind: 'image', name: 'x' })).error!, /not found|Tool create_project/i);
});

test('an agent with a deploy token creates, configures, deploys and debugs a project', async (t) => {
  const h = harness(t);
  const v1 = h.fakeDocker.push(REF, 'healthy');
  const broken = h.fakeDocker.push('localhost:5050/library/hello:broken', 'unhealthy');
  const { call } = await h.agent('deploy');

  const created = await call<{ name: string; hostname: string }>('create_project', {
    kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080, healthPath: '/health',
  });
  assert.deepEqual([created.name, created.hostname], ['hello', 'hello.localhost']);
  await call('set_env', { project: 'hello', set: { GREETING: { value: 'hi' }, API_KEY: { value: SECRET, secret: true } } });

  // deploy returns at once with an id; progress is read from the logs.
  const started = await call<{ deployId: number; status: string }>('deploy', { project: 'hello' });
  assert.equal(started.status, 'queued');
  await h.queue.idle();
  const logs = await call<{ finished: boolean; deploy: { status: string; trigger: string }; lines: Array<{ seq: number; line: string }>; nextAfterSeq: number }>(
    'get_deploy_logs', { deployId: started.deployId },
  );
  assert.deepEqual([logs.finished, logs.deploy.status, logs.deploy.trigger], [true, 'healthy', 'mcp']);
  assert.equal(logs.nextAfterSeq, logs.lines.at(-1)!.seq);
  assert.deepEqual((await call<{ lines: unknown[] }>('get_deploy_logs', { deployId: started.deployId, afterSeq: logs.nextAfterSeq })).lines, []);

  const status = await call<{ status: string; liveVersion: string; containers: Array<{ name: string; state: string }> }>('get_status', { project: 'hello' });
  assert.deepEqual([status.status, status.liveVersion, status.containers.map((c) => `${c.name}:${c.state}`)], ['running', v1, ['hello:running']]);

  // A bad version fails; the agent reads why, and the last healthy one keeps serving.
  const bad = await call<{ deployId: number }>('deploy', { project: 'hello', digest: broken });
  await h.queue.idle();
  const failed = await call<{ deploy: { status: string; failureReason: string } }>('get_deploy_logs', { deployId: bad.deployId });
  assert.equal(failed.deploy.status, 'failed');
  assert.match(failed.deploy.failureReason, /timed out/);
  assert.equal((await call<Array<{ status: string }>>('list_deploys', { project: 'hello' }))[0]!.status, 'failed');
  assert.equal(h.fakeDocker.runningDigest('hello'), v1);

  h.fakeDocker.logLines.set('hello', [{ stream: 'stderr', line: 'listening on 8080' }]);
  const container = await call<{ container: string; lines: Array<{ line: string }> }>('get_container_logs', { project: 'hello' });
  assert.deepEqual([container.container, container.lines[0]!.line], ['hello', 'listening on 8080']);

  // Fixing it: a config change and a redeploy of the good tag.
  await call('update_project', { project: 'hello', healthPath: '/' });
  const again = await call<{ deployId: number }>('deploy', { project: 'hello' });
  await h.queue.idle();
  assert.equal(h.deploys.get(again.deployId).status, 'healthy');

  const entry = h.audit.list().find((e) => e.action === 'deploy.request')!;
  assert.equal(entry.actorType, 'token');
  assert.equal(entry.details.trigger, 'mcp');
});

test('no tool ever returns a secret value', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const { client, call } = await h.agent('admin');
  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  const setResult = await client.callTool({ name: 'set_env', arguments: { project: 'hello', set: { API_KEY: { value: SECRET, secret: true } } } });
  const d = await call<{ deployId: number }>('deploy', { project: 'hello' });
  await h.queue.idle();

  const outputs = [JSON.stringify(setResult)];
  for (const [name, args] of [
    ['list_projects', {}], ['get_project', { project: 'hello' }], ['get_status', { project: 'hello' }],
    ['list_deploys', { project: 'hello' }], ['get_deploy_logs', { deployId: d.deployId }], ['get_container_logs', { project: 'hello' }],
    ['restart', { project: 'hello' }],
  ] as const) {
    outputs.push(JSON.stringify(await client.callTool({ name, arguments: args })));
  }
  for (const out of outputs) assert.doesNotMatch(out, new RegExp(SECRET));
  const env = (await call<{ env: Array<{ key: string; value: string | null; isSecret: boolean }> }>('get_project', { project: 'hello' })).env;
  assert.deepEqual(env.map((e) => [e.key, e.value, e.isSecret]), [['API_KEY', null, true]]);
});

test('compose projects through MCP: refused YAML is a tool error naming the key', async (t) => {
  const h = harness(t);
  h.fakeDocker.push('nginx:1.29', 'healthy');
  const { call } = await h.agent('deploy');
  const yaml = 'services:\n  app:\n    image: nginx:1.29\n';
  await call('create_project', { kind: 'compose', name: 'blog', composeYaml: yaml, routedService: 'app', port: 80 });

  const evil = await call('update_compose', { project: 'blog', composeYaml: `${yaml}    privileged: true\n`, routedService: 'app', port: 80 });
  assert.match(evil.error!, /^validation: services\.app\.privileged: is not allowed/);
  const v2 = await call<{ version: number }>('update_compose', { project: 'blog', composeYaml: yaml, routedService: 'app', port: 80, note: 'same again' });
  assert.equal(v2.version, 2);

  const d = await call<{ deployId: number }>('deploy', { project: 'blog', composeVersion: 1 });
  await h.queue.idle();
  assert.equal(h.deploys.get(d.deployId).status, 'healthy');
  const p = await call<{ project: { deployedComposeVersion: number }; composeYaml: string }>('get_project', { project: 'blog' });
  assert.equal(p.project.deployedComposeVersion, 1);
  assert.equal(p.composeYaml, yaml);
});

test('stop drops the route until start; lifecycle waits for deploys and needs a deployed project', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const { call } = await h.agent('deploy');
  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  assert.match((await call('stop', { project: 'hello' })).error!, /has not been deployed/);

  await call('deploy', { project: 'hello' });
  assert.match((await call('restart', { project: 'hello' })).error!, /deploy in progress/);
  await h.queue.idle();

  const stopped = await call<{ status: string; containers: Array<{ state: string }> }>('stop', { project: 'hello' });
  assert.deepEqual([stopped.status, stopped.containers[0]!.state], ['stopped', 'exited']);
  assert.equal(h.fakeCaddy.routes.size, 0);
  assert.deepEqual(h.routes.desired(), []);

  const started = await call<{ status: string }>('start', { project: 'hello' });
  assert.equal(started.status, 'running');
  assert.equal(h.fakeCaddy.routes.size, 1);
  assert.ok(h.audit.list().some((e) => e.action === 'project.stop'));
});

test('list_registries shows logins without their tokens', async (t) => {
  const h = harness(t);
  h.registries.create(h.ctx, { name: 'RepoFlow', url: 'https://repoflow.example.com', username: 'ci', token: 'very-secret' });
  const { call } = await h.agent('read');
  const list = await call<Array<{ name: string; host: string; username: string; hasToken: boolean }>>('list_registries');
  assert.deepEqual(list.map((r) => [r.name, r.host, r.username, r.hasToken]), [['RepoFlow', 'repoflow.example.com', 'ci', true]]);
  assert.doesNotMatch(JSON.stringify(list), /very-secret/);
});

test('rotate_webhook returns a working URL once, and rotating replaces it', async (t) => {
  const h = harness(t);
  const { call } = await h.agent('admin');
  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });

  const first = await call<{ url: string; replaced: boolean; project: string }>('rotate_webhook', { project: 'hello' });
  assert.equal(first.replaced, false);
  assert.equal(first.project, 'hello');
  assert.match(first.url, /^http:\/\/vibeship\.localhost:8080\/hooks\/deploy\/\S+$/);
  assert.equal((await call<{ project: { hasWebhook: boolean } }>('get_project', { project: 'hello' })).project.hasWebhook, true);
  assert.doesNotMatch(JSON.stringify(await call('get_project', { project: 'hello' })), new RegExp(first.url.split('/').at(-1)!));

  const second = await call<{ url: string; replaced: boolean }>('rotate_webhook', { project: 'hello' });
  assert.equal(second.replaced, true);
  assert.notEqual(second.url, first.url);
  const actions = h.audit.list().map((e) => e.action);
  assert.ok(actions.includes('webhook.create') && actions.includes('webhook.rotate'));

  await call('create_project', { kind: 'compose', name: 'stack', composeYaml: 'services:\n  app:\n    image: nginx:1.29\n', routedService: 'app', port: 80 });
  assert.match((await call('rotate_webhook', { project: 'stack' })).error ?? '', /^validation: .*only image projects/);
});

test('delete_project is admin only, and errors come back as tool errors', async (t) => {
  const h = harness(t);
  const { call } = await h.agent('admin');
  assert.equal((await call('get_project', { project: 'nope' })).error, 'not_found: Project "nope" not found');
  assert.match((await call('create_project', { kind: 'image', name: 'Bad Name' })).error!, /^validation: /);

  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  assert.deepEqual(await call('delete_project', { project: 'hello' }), { deleted: 'hello', dataDeleted: false });
  assert.deepEqual(await call('list_projects'), []);
});

test('initialize returns the short contract, pointing to get_deploy_guide', async (t) => {
  const h = harness(t);
  const { client } = await h.agent('read');
  const instructions = client.getInstructions()!;
  assert.ok(instructions.split('\n').length <= 40, 'instructions stay under 40 lines');
  for (const part of [
    'api.repoflow.io/hiranyeyg-6713/vibes/<project>', ':latest and :<git sha>', '{"digest":"sha256:<64 hex>"',
    'create_project', 'rotate_webhook', 'WEBHOOK_URL', 'list_deploys', 'get_status', 'get_deploy_guide', '<project>.localhost',
    'If the image runs as a non-root user, set dataOwner (e.g. "1000:1000") so it can write /data.',
  ]) assert.ok(instructions.includes(part), `instructions mention ${part}`);
  assert.ok(instructions.indexOf('create_project') < instructions.indexOf('rotate_webhook'));
  assert.ok(instructions.indexOf('rotate_webhook') < instructions.indexOf('list_deploys'));
});

const SECTIONS = ['## Image and registry', '## Persistent data', '## Env vars and secrets', '## Networking', '## Health checks', '## Webhook and CI', '## Troubleshooting'];

test('get_deploy_guide renders the general guide, for each kind, with a read token', async (t) => {
  const h = harness(t);
  const { client } = await h.agent('read');
  const guide = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: 'get_deploy_guide', arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    assert.ok(!r.isError, r.content[0]?.text ?? "tool error");
    return r.content[0]!.text;
  };

  const all = await guide({});
  for (const s of [...SECTIONS, '## Compose projects']) assert.ok(all.includes(s), `general guide has ${s}`);
  assert.doesNotMatch(all, /## This project/);

  const image = await guide({ kind: 'image' });
  for (const s of SECTIONS) assert.ok(image.includes(s), `image guide has ${s}`);
  assert.doesNotMatch(image, /## Compose projects/);
  assert.match(image, /secrets\.REPOFLOW_USERNAME/);
  assert.match(image, /secrets\.REPOFLOW_PASSWORD/);
  assert.match(image, /secrets\.WEBHOOK_URL/);
  assert.match(image, /curl -fsS --retry 3/);

  const compose = await guide({ kind: 'compose' });
  assert.match(compose, /## Compose projects/);
  assert.match(compose, /only image projects have one/);
  assert.doesNotMatch(compose, /secrets\.WEBHOOK_URL/);
});

test('get_deploy_guide fills in a project\'s real values', async (t) => {
  const h = harness(t);
  const digest = h.fakeDocker.push(REF, 'healthy');
  const { call, client } = await h.agent('admin');
  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080, healthPath: '/health' });
  await call('set_env', { project: 'hello', set: { GREETING: { value: 'plain-value-xyz' }, API_KEY: { value: SECRET, secret: true } } });
  await call('rotate_webhook', { project: 'hello' });
  await call('deploy', { project: 'hello' });
  await h.queue.idle();

  const r = await client.callTool({ name: 'get_deploy_guide', arguments: { project: 'hello' } }) as { content: Array<{ text: string }> };
  const text = r.content[0]!.text;
  assert.match(text, /## This project: hello/);
  for (const part of [
    '`localhost:5050/library/hello:latest`', '`hello.localhost` (the default)', 'Port: `8080`', 'http://hello:8080/health',
    `\`${h.stackRoot}/hello/data\` mounted at \`/data\``, '`API_KEY` (secret)', '`GREETING`', 'Webhook: exists', `Live digest: \`${digest}\``,
    '`healthy`', 'IMAGE: localhost:5050/library/hello',
  ]) assert.ok(text.includes(part), `project guide includes ${part}`);
  assert.doesNotMatch(text, /plain-value-xyz/, 'not even plain env values are shown');

  const compose = await call('create_project', { kind: 'compose', name: 'blog', composeYaml: 'services:\n  app:\n    image: nginx:1.29\n    volumes:\n      - ./data:/srv\n', routedService: 'app', port: 80 });
  assert.ok(!('error' in compose && compose.error), JSON.stringify(compose));
  const c = (await client.callTool({ name: 'get_deploy_guide', arguments: { project: 'blog', kind: 'image' } }) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(c, /^# Deploying blog \(compose project\) to Vibeship/);
  assert.ok(c.includes('mounted by `app` at `/srv`'));
  assert.ok(c.includes('blog-blog-1'));
  assert.match(c, /Last deploy: none yet/);

  assert.equal((await call('get_deploy_guide', { project: 'nope' })).error, 'not_found: Project "nope" not found');
});

test('the guide, resource and prompt never contain secrets, webhook URLs or tokens', async (t) => {
  const h = harness(t);
  h.fakeDocker.push(REF, 'healthy');
  const REGISTRY_TOKEN = 'registry-t0ken-do-not-leak';
  h.registries.create(h.ctx, { name: 'Local', url: 'localhost:5050', username: 'puller', token: REGISTRY_TOKEN });
  const { client, call } = await h.agent('admin');
  const { token: apiToken } = h.tokens.create(h.ctx, { name: 'other', scope: 'deploy' });
  await call('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080, dataOwner: `${process.getuid!()}:${process.getgid!()}` });
  await call('set_env', { project: 'hello', set: { API_KEY: { value: SECRET, secret: true }, PLAIN: { value: 'visible-plain-value' } } });
  const { url } = await call<{ url: string }>('rotate_webhook', { project: 'hello' });
  await call('deploy', { project: 'hello' });
  await h.queue.idle();

  const outputs: string[] = [];
  for (const args of [{}, { kind: 'image' }, { kind: 'compose' }, { project: 'hello' }]) {
    outputs.push(JSON.stringify(await client.callTool({ name: 'get_deploy_guide', arguments: args })));
  }
  outputs.push(JSON.stringify(await client.readResource({ uri: 'vibeship://guide' })));
  outputs.push(JSON.stringify(await client.getPrompt({ name: 'ship_new_app', arguments: { project: 'hello' } })));
  outputs.push(client.getInstructions()!);

  const webhookToken = url.split('/').at(-1)!;
  for (const out of outputs) {
    for (const secret of [SECRET, 'visible-plain-value', webhookToken, url, REGISTRY_TOKEN, apiToken]) {
      assert.ok(!out.includes(secret), `output leaks ${secret.slice(0, 12)}…`);
    }
    assert.doesNotMatch(out, /\/hooks\/deploy\/[A-Za-z0-9_-]{10,}/);
  }
  assert.ok(outputs[3]!.includes(`data owner: \`${process.getuid!()}:${process.getgid!()}\` (applied on each deploy)`));
  // The registry is reported by name and login state only.
  assert.match(outputs[3]!, /`Local` \(id \d+, host `localhost:5050`, matched by host\), pulls with its login/);
});

test('dataOwner through MCP: set on create, shown by get_project and the guide, changed and cleared by update_project', async (t) => {
  const h = harness(t);
  const { call } = await h.agent('deploy');
  type Got = { project: { image: { dataOwner: string | null } }; drift: { pendingChanges: boolean } };

  const created = await call<{ image: { dataOwner: string | null } }>('create_project', { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080, dataOwner: '1000:1000' });
  assert.equal(created.image.dataOwner, '1000:1000');
  assert.equal((await call<Got>('get_project', { project: 'hello' })).project.image.dataOwner, '1000:1000');

  assert.equal((await call('update_project', { project: 'hello', dataOwner: '70000:1' })).error, 'validation: dataOwner: must be "<uid>:<gid>" like "1000:1000"');
  assert.equal((await call('update_project', { project: 'hello', dataOwner: '1000' })).error, 'validation: dataOwner: must be "<uid>:<gid>" like "1000:1000"');
  assert.equal((await call<{ image: { dataOwner: string | null } }>('update_project', { project: 'hello', dataOwner: null })).image.dataOwner, null);

  const compose = await call('create_project', { kind: 'compose', name: 'blog', composeYaml: 'services:\n  app:\n    image: nginx:1.29\n', routedService: 'app', port: 80, dataOwner: '1000:1000' });
  assert.match(compose.error ?? '', /^validation: dataOwner: only image projects have a data owner/);
});

test('every scope gets the guide resource and the ship_new_app prompt', async (t) => {
  const h = harness(t);
  const { client } = await h.agent('read');
  assert.deepEqual((await client.listResources()).resources.map((r) => [r.uri, r.mimeType]), [['vibeship://guide', 'text/markdown']]);
  const resource = await client.readResource({ uri: 'vibeship://guide' });
  const text = (resource.contents[0] as { text: string }).text;
  assert.match(text, /^# Deploying to Vibeship\n/);
  assert.match(text, /## Compose projects/);

  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ['ship_new_app']);
  const prompt = await client.getPrompt({ name: 'ship_new_app', arguments: { project: 'shop' } });
  const steps = (prompt.messages[0]!.content as { text: string }).text;
  const order = ['get_deploy_guide', 'create_project', 'set_env', 'rotate_webhook', 'Push to main', 'list_deploys', 'get_status'].map((x) => steps.indexOf(x));
  assert.ok(order.every((i) => i >= 0), steps);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'steps come in the setup order');
  assert.match(steps, /api\.repoflow\.io\/hiranyeyg-6713\/vibes\/shop:latest/);

  const compose = await client.getPrompt({ name: 'ship_new_app', arguments: { project: 'shop', kind: 'compose' } });
  assert.doesNotMatch((compose.messages[0]!.content as { text: string }).text, /rotate_webhook/);
});
