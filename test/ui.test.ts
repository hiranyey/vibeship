import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { generateMasterKey } from '../src/crypto/master-key.ts';
import { parseEnvLines } from '../src/ui/projects.ts';
import { setup } from './helpers.ts';

const ORIGIN = 'http://vibeship.localhost:8080';
const REF = 'localhost:5050/library/hello:latest';

/** The app with a logged-in browser: `get` and `post` send the session cookie and, for posts, the Origin a browser would. */
function browser(t: TestContext) {
  const s = setup(t);
  const config = loadConfig({ PUBLIC_URL: ORIGIN, STACK_ROOT: s.stackRoot, BASE_DOMAIN: 'localhost', MASTER_KEY: generateMasterKey() });
  const app = createApp({ config, db: s.db, services: s, oidc: null });
  const { token } = s.sessions.login({ sub: 'user_clerk', email: 'admin@example.com', name: 'Admin' }, { ip: null, userAgent: 'test' });
  let cookies: Record<string, string> = { vs_session: token };

  const remember = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c)) delete cookies[k!];
      else cookies[k!] = v!;
    }
    return res;
  };
  const cookie = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  const get = async (path: string) => remember(await app.request(path, { headers: { cookie: cookie() } }));
  const post = async (path: string, form: Record<string, string> = {}, headers: Record<string, string> = { origin: ORIGIN }) =>
    remember(await app.request(path, {
      method: 'POST',
      headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    }));
  /** Follows a 303 and returns the page it lands on. */
  const follow = async (res: Response) => {
    assert.equal(res.status, 303, `expected a redirect, got ${res.status}: ${(await res.clone().text()).slice(0, 400)}`);
    const to = res.headers.get('location')!;
    const page = await get(to);
    return { to, res: page, text: await page.text() };
  };
  return { ...s, app, get, post, follow, setCookies: (c: Record<string, string>) => { cookies = c; } };
}

test('without a session, pages redirect to the login and keep where you were going', async (t) => {
  const b = browser(t);
  b.setCookies({});
  const res = await b.get('/projects/new?kind=image');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login?returnTo=%2Fprojects%2Fnew%3Fkind%3Dimage');
  // A form posted after the session expired goes to the login too.
  const posted = await b.post('/projects/new', { kind: 'image' });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get('location'), '/auth/login');
});

test('API tokens do not open the UI', async (t) => {
  const b = browser(t);
  const { token } = b.tokens.create(b.ctx, { name: 'admin', scope: 'admin' });
  const res = await b.app.request('/', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /needs a login/);
});

test('the dashboard and every page render with security headers', async (t) => {
  const b = browser(t);
  for (const path of ['/', '/projects/new', '/projects/new?kind=image', '/projects/new?kind=compose', '/settings', '/settings/registries', '/settings/tokens', '/settings/audit']) {
    const res = await b.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  }
  const home = await (await b.get('/')).text();
  assert.match(home, /No projects yet/);
  assert.match(home, /data-metrics="\/api\/metrics"/, 'the dashboard shows the server panel');
  assert.match(home, /data-copy-text="http:\/\/vibeship\.localhost:8080\/mcp"/, 'the MCP URL has a copy button');
  // The topbar shows only the log out button, not the user's name, email or an admin badge.
  assert.match(home, /<form method="post" action="\/auth\/logout">/);
  assert.doesNotMatch(home, /admin@example\.com|class="user-chip"|class="brand-sub"/);
});

test('static assets are served', async (t) => {
  const b = browser(t);
  const css = await b.app.request('/static/vibeship.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type')!, /text\/css/);
  assert.match(await css.text(), /--accent: #e85d04/);
  const js = await b.app.request('/static/ui.js');
  assert.match(js.headers.get('content-type')!, /javascript/);
  assert.match(await js.text(), /EventSource/);
  assert.equal((await b.app.request('/static/nope.js')).status, 404);
});

test('self-hosted fonts are served for every @font-face in vibeship.css', async (t) => {
  const b = browser(t);
  const css = await (await b.app.request('/static/vibeship.css')).text();
  const files = [...css.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]!);
  assert.equal(files.length, 6);
  for (const file of files) {
    const res = await b.app.request(`/static/fonts/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4)), 'wOF2', file);
  }
  assert.equal((await b.app.request('/static/fonts/nope.woff2')).status, 404);
});

test('the wizard creates an image project with env, deploys it, and shows the live deploy', async (t) => {
  const b = browser(t);
  b.fakeDocker.push(REF, 'healthy');
  const { to, text } = await b.follow(await b.post('/projects/new', {
    kind: 'image', name: 'hello', imageRef: REF, containerPort: '8080', healthPath: '/health',
    env: 'GREETING=hi\n# comment\n\nexport MODE=prod', secretEnv: 'API_KEY=s3cret', deploy: 'on',
  }));
  assert.match(to, /^\/deploys\/\d+$/);
  assert.match(text, /Created hello; deploy #1 is under way/);

  const p = b.projects.getByName('hello');
  assert.deepEqual(b.env.list(p.id).map((e) => [e.key, e.value, e.isSecret]), [['API_KEY', null, true], ['GREETING', 'hi', false], ['MODE', 'prod', false]]);

  await b.queue.idle();
  const done = await (await b.get(to)).text();
  assert.match(done, /pill-healthy" data-status="healthy"/);
  assert.doesNotMatch(done, /data-stream=/, 'a finished deploy does not stream');
  assert.match(done, /Deploy #1 is live/);

  for (const tab of ['', '/deploys', '/logs', '/env', '/settings']) {
    const res = await b.get(`/projects/hello${tab}`);
    assert.equal(res.status, 200, tab);
  }
  const overview = await (await b.get('/projects/hello')).text();
  assert.match(overview, /hello\.localhost/);
  assert.match(overview, /data-metrics="\/api\/projects\/\d+\/metrics"/, 'the overview shows the project panel');
  assert.match(overview, /data-ct="hello" data-usage="cpu"/);
  assert.match(overview, /sha256:/);
  assert.doesNotMatch(await (await b.get('/projects/hello/env')).text(), /s3cret/, 'secret values are never shown');
  assert.match(await (await b.get('/projects/hello/logs')).text(), /data-stream="\/api\/projects\/\d+\/logs\?tail=300"/);
  assert.match(await (await b.get('/')).text(), /<a href="\/projects\/hello">hello<\/a>/);
});

test('a deploy that has not finished streams its log from where the page left off', async (t) => {
  const b = browser(t);
  const p = b.projects.create(b.ctx, { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  // Inserted without kicking the queue, so it stays queued.
  const id = b.db.run(`INSERT INTO deploys (project_id, trigger, actor) VALUES (?, 'ui', 'test')`, p.id).lastInsertRowid;
  b.db.run(`INSERT INTO deploy_logs (deploy_id, seq, stream, line) VALUES (?, 1, 'system', 'first line')`, id);
  const text = await (await b.get(`/deploys/${id}`)).text();
  assert.match(text, new RegExp(`data-stream="/api/deploys/${id}/logs\\?after=1"`));
  assert.match(text, /first line/);
  assert.match(text, /pill-queued" data-status="queued"/);
});

test('wizard errors keep what was typed, except secrets', async (t) => {
  const b = browser(t);
  const res = await b.post('/projects/new', { kind: 'image', name: 'Bad Name', imageRef: REF, containerPort: '8080', env: 'KEEP=me', secretEnv: 'API_KEY=s3cret' });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /The project was not created/);
  assert.match(text, /name: use 1-32 lowercase/);
  assert.match(text, /value="Bad Name"/);
  assert.match(text, />KEEP=me</);
  assert.doesNotMatch(text, /s3cret/);

  const badEnv = await b.post('/projects/new', { kind: 'image', name: 'ok', imageRef: REF, containerPort: '8080', env: 'no equals sign' });
  assert.equal(badEnv.status, 400);
  assert.match(await badEnv.text(), /Env line 1: expected KEY=value/);
  assert.equal(b.projects.list().length, 0, 'nothing is created when env is invalid');
});

test('user content is escaped', async (t) => {
  const b = browser(t);
  b.projects.create(b.ctx, { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  await b.follow(await b.post('/projects/hello/env', { env: 'X=<script>alert(1)</script>' }));
  const text = await (await b.get('/projects/hello/env')).text();
  assert.doesNotMatch(text, /<script>alert/);
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('env can be set, made secret and removed', async (t) => {
  const b = browser(t);
  const p = b.projects.create(b.ctx, { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });
  let page = await b.follow(await b.post('/projects/hello/env', { env: 'A=1\nB=2' }));
  assert.match(page.text, /Env saved/);
  page = await b.follow(await b.post('/projects/hello/env', { env: 'B=hidden', secret: 'on' }));
  page = await b.follow(await b.post('/projects/hello/env/unset', { key: 'A' }));
  assert.match(page.text, /Removed A/);
  assert.deepEqual(b.env.list(p.id).map((e) => [e.key, e.value, e.isSecret]), [['B', null, true]]);
  page = await b.follow(await b.post('/projects/hello/env', { env: 'DOCKER_HOST=x' }));
  assert.match(page.text, /alert-danger/);
  assert.match(page.text, /reserved for Docker/);
});

test('compose projects: create, save a new version and deploy an older one', async (t) => {
  const b = browser(t);
  const yaml = 'services:\n  app:\n    image: nginx:1.29\n';
  b.fakeDocker.push('nginx:1.29', 'healthy');
  b.fakeDocker.push('nginx:1.30', 'healthy');
  const created = await b.follow(await b.post('/projects/new', { kind: 'compose', name: 'blog', composeYaml: yaml, routedService: 'app', port: '80' }));
  assert.equal(created.to, '/projects/blog');
  assert.match((await (await b.get('/projects/blog')).text()), /href="\/projects\/blog\/compose"/);

  const bad = await b.post('/projects/blog/compose', { composeYaml: 'services:\n  app:\n    image: x\n    privileged: true\n', routedService: 'app', port: '80' });
  assert.equal(bad.status, 400);
  const badText = await bad.text();
  assert.match(badText, /privileged/);
  assert.match(badText, /privileged: true/, 'the YAML is kept for fixing');

  const saved = await b.follow(await b.post('/projects/blog/compose', { composeYaml: yaml.replace('1.29', '1.30'), routedService: 'app', port: '80', note: 'bump', deploy: 'on' }));
  assert.match(saved.to, /^\/deploys\/\d+$/);
  await b.queue.idle();
  const versions = await (await b.get('/projects/blog/compose')).text();
  assert.match(versions, /v2<\/a> <span class="badge">live/);
  assert.match(await (await b.get('/projects/blog/compose/1')).text(), /nginx:1\.29/);
  const v2 = await (await b.get('/projects/blog/compose/2')).text();
  assert.match(v2, /Changes from v1/);
  assert.match(v2, /class="diff-text diff-del">    image: nginx:1\.29</);
  assert.match(v2, /class="diff-text diff-add">    image: nginx:1\.30</);
  assert.match(versions, /href="\/projects\/blog\/compose\/2#diff">diff v1</);

  const again = await b.follow(await b.post('/projects/blog/deploy', { composeVersion: '1' }));
  await b.queue.idle();
  assert.match(await (await b.get(again.to)).text(), /compose version 1/);
  assert.equal(b.projects.getByName('blog').deployedComposeVersion, 1);
  assert.equal((await b.get('/projects/blog/compose/9')).status, 404);
});

test('settings: update, webhook shown once, stop/start, delete with confirmation', async (t) => {
  const b = browser(t);
  b.fakeDocker.push(REF, 'healthy');
  b.projects.create(b.ctx, { kind: 'image', name: 'hello', imageRef: REF, containerPort: 8080 });

  const saved = await b.follow(await b.post('/projects/hello/settings', { hostname: 'hi.localhost', imageRef: REF, containerPort: '9090', registryId: '', healthPath: '/up', memLimit: '' }));
  assert.match(saved.text, /Saved/);
  const p = b.projects.getByName('hello');
  assert.equal(p.hostname, 'hi.localhost');
  assert.deepEqual([p.image!.containerPort, p.image!.healthPath, p.image!.memLimit], [9090, '/up', null]);
  assert.equal(p.image!.dataOwner, null);

  const page = await (await b.get('/projects/hello/settings')).text();
  assert.match(page, /Data owner \(uid:gid\)/);
  assert.match(page, /Set to 1000:1000 for images that run as the node user/);
  await b.follow(await b.post('/projects/hello/settings', { hostname: 'hi.localhost', imageRef: REF, containerPort: '9090', healthPath: '/up', dataOwner: '1000:1000' }));
  assert.equal(b.projects.getByName('hello').image!.dataOwner, '1000:1000');
  assert.match(await (await b.get('/projects/hello/settings')).text(), /id="f-dataOwner" name="dataOwner" type="text"\s+value="1000:1000"/);
  const badOwner = await b.post('/projects/hello/settings', { hostname: 'hi.localhost', imageRef: REF, containerPort: '9090', dataOwner: '1000' });
  assert.equal(badOwner.status, 400);
  assert.ok((await badOwner.text()).includes('dataOwner: must be &quot;&lt;uid&gt;:&lt;gid&gt;&quot; like &quot;1000:1000&quot;'));
  await b.follow(await b.post('/projects/hello/settings', { hostname: 'hi.localhost', imageRef: REF, containerPort: '9090', healthPath: '/up', dataOwner: '' }));
  assert.equal(b.projects.getByName('hello').image!.dataOwner, null, 'an empty field clears it');

  const bad = await b.post('/projects/hello/settings', { hostname: 'hi.localhost', imageRef: REF, containerPort: 'abc' });
  assert.equal(bad.status, 400);

  const hook = await b.post('/projects/hello/webhook');
  assert.equal(hook.status, 200);
  const url = /id="once-value">([^<]+)</.exec(await hook.text())![1]!;
  assert.match(url, /^http:\/\/vibeship\.localhost:8080\/hooks\/deploy\/[\w-]{43}$/);
  assert.equal(b.projects.findByWebhookToken(url.split('/').at(-1)!)?.name, 'hello');
  assert.doesNotMatch(await (await b.get('/projects/hello/settings')).text(), /hooks\/deploy\/[\w-]{43}/, 'not shown again');

  // Lifecycle needs a deploy first.
  const early = await b.follow(await b.post('/projects/hello/stop'));
  assert.match(early.text, /has not been deployed yet/);
  await b.follow(await b.post('/projects/hello/deploy'));
  await b.queue.idle();
  assert.match((await b.follow(await b.post('/projects/hello/stop'))).text, /Stopped hello/);
  assert.equal(b.projects.getByName('hello').status, 'stopped');
  assert.match((await b.follow(await b.post('/projects/hello/start'))).text, /Started hello/);

  const wrong = await b.follow(await b.post('/projects/hello/delete', { confirmName: 'nope' }));
  assert.match(wrong.text, /Type hello exactly/);
  const gone = await b.follow(await b.post('/projects/hello/delete', { confirmName: 'hello' }));
  assert.equal(gone.to, '/');
  assert.match(gone.text, /Deleted hello; its data\/ folder and volumes were kept/);
  assert.equal(b.projects.list().length, 0);
  assert.equal((await b.get('/projects/hello')).status, 404);
});

test('tokens are shown once and can be revoked; registries and settings save', async (t) => {
  const b = browser(t);
  const res = await b.post('/settings/tokens', { name: 'agent', scope: 'deploy', expiresOn: '' });
  assert.equal(res.status, 200);
  const text = await res.text();
  const token = /id="once-value">(vs_[^<]+)</.exec(text)![1]!;
  assert.equal(b.tokens.authenticate(token)?.scope, 'deploy');
  assert.match(text, /claude mcp add --transport http vibeship http:\/\/vibeship\.localhost:8080\/mcp/);
  assert.doesNotMatch(await (await b.get('/settings/tokens')).text(), new RegExp(token));

  const past = await b.post('/settings/tokens', { name: 'old', scope: 'read', expiresOn: '2001-01-01' });
  assert.equal(past.status, 400);
  assert.match(await past.text(), /must be in the future/);

  const id = b.tokens.list().find((x) => x.name === 'agent')!.id;
  assert.match((await b.follow(await b.post(`/settings/tokens/${id}/revoke`))).text, /Revoked agent/);
  assert.equal(b.tokens.authenticate(token), null);

  const reg = await b.follow(await b.post('/settings/registries', { name: 'RepoFlow', url: 'https://repoflow.example.com', username: 'ci', token: 'tok' }));
  assert.match(reg.text, /Added RepoFlow/);
  assert.doesNotMatch(reg.text, /tok</);
  const half = await b.post('/settings/registries', { name: 'Half', url: 'x.example.com', username: 'ci', token: '' });
  assert.equal(half.status, 400);

  const regId = b.registries.list().find((x) => x.name === 'RepoFlow')!.id;
  const edit = await (await b.get(`/settings/registries/${regId}`)).text();
  assert.match(edit, /value="https:\/\/repoflow\.example\.com"/);
  assert.match(edit, /Leave blank to keep the current token/);
  const renamed = await b.follow(await b.post(`/settings/registries/${regId}`, { name: 'Repoflow', url: 'https://api.repoflow.io', username: 'deployer', token: '' }));
  assert.match(renamed.text, /Saved Repoflow/);
  assert.deepEqual(b.registries.authFor('api.repoflow.io/lib/app:1', null), { host: 'api.repoflow.io', username: 'deployer', password: 'tok' });
  await b.follow(await b.post(`/settings/registries/${regId}`, { name: 'Repoflow', url: 'https://api.repoflow.io', username: '', token: '' }));
  assert.equal(b.registries.get(regId).hasToken, false);
  const noToken = await b.post(`/settings/registries/${regId}`, { name: 'Repoflow', url: 'https://api.repoflow.io', username: 'ci', token: '' });
  assert.equal(noToken.status, 400);
  assert.match(await noToken.text(), /token: required/);
  assert.equal((await b.get('/settings/registries/999')).status, 404);

  assert.match((await b.follow(await b.post('/settings', { health_timeout_seconds: '120' }))).text, /Settings saved/);
  assert.equal(b.settings.get('health_timeout_seconds'), 120);
  assert.equal((await b.post('/settings', { health_timeout_seconds: '1' })).status, 400);

  const audit = await (await b.get('/settings/audit')).text();
  for (const action of ['token.create', 'token.revoke', 'registry.create', 'registry.update', 'settings.set']) assert.match(audit, new RegExp(action.replace('.', '\\.')));
  assert.match(audit, /admin@example\.com/);
});

test('cross-origin form posts are refused', async (t) => {
  const b = browser(t);
  const res = await b.post('/settings/tokens', { name: 'evil', scope: 'admin' }, { origin: 'http://evil.localhost:8080' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Cross-origin request refused/);
  const none = await b.post('/settings/tokens', { name: 'evil', scope: 'admin' }, {});
  assert.equal(none.status, 403);
  assert.equal(b.tokens.list().length, 0);
});

test('missing pages are HTML for people and JSON for the API', async (t) => {
  const b = browser(t);
  const page = await b.get('/projects/nope');
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Project &quot;nope&quot; not found/);
  const other = await b.get('/no/such/page');
  assert.equal(other.status, 404);
  assert.match(other.headers.get('content-type')!, /text\/html/);
  const api = await b.get('/api/nope');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type')!, /json/);
});

test('parseEnvLines reads KEY=value lines', () => {
  assert.deepEqual(parseEnvLines('A=1\n  # c\n\nexport B=x=y\nC=', true), {
    A: { value: '1', secret: true }, B: { value: 'x=y', secret: true }, C: { value: '', secret: true },
  });
  assert.throws(() => parseEnvLines('A=1\nA=2', false), /A is set twice/);
  assert.throws(() => parseEnvLines('=1', false), /expected KEY=value/);
});

test('brand icons are served and every page uses the mark instead of a text badge', async (t) => {
  const b = browser(t);
  const mark = await b.app.request('/static/vibeship-mark.svg');
  assert.equal(mark.status, 200);
  assert.match(mark.headers.get('content-type')!, /image\/svg\+xml/);
  for (const [path, type] of [['/favicon.ico', /image\/x-icon/], ['/favicon.svg', /svg/], ['/apple-touch-icon.png', /image\/png/], ['/icon-192.png', /image\/png/], ['/site.webmanifest', /manifest\+json/]] as const) {
    const res = await b.app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type')!, type);
  }
  const home = await (await b.get('/')).text();
  assert.match(home, /<img class="brand-mark" src="\/static\/vibeship-mark\.svg"/);
  assert.match(home, /<link rel="icon" href="\/favicon\.svg"/);
  assert.doesNotMatch(home, />VS</);
  const login = await (await b.app.request('/auth/login')).text();
  assert.match(login, /vibeship-mark\.svg/);
  assert.doesNotMatch(login, />VS</);
});
