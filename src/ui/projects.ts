import { type Context, Hono } from 'hono';
import { html, raw } from 'hono/html';
import type { Config } from '../config.ts';
import { DeployEngine } from '../deploy/engine.ts';
import { AppError } from '../errors.ts';
import { type AppEnv, principal } from '../http/auth.ts';
import { SetEnvInput } from '../schemas.ts';
import type { Deploy } from '../services/deploys.ts';
import type { Services } from '../services/index.ts';
import type { Project } from '../services/projects.ts';
import { parseInput } from '../services/validate.ts';
import {
  absoluteTime, ACTIONS, ago, alert, checkbox, confirmAttrs, copyable, copyButton, dataTable, drawer, duration, emptyRow, emptyState, externalLink, field,
  type FieldErrors, fieldErrors, type Html, imageVersion, linkButton, pageHeader, postButton, selectField, shortDigest, shownOnce,
  statusBadge, tag, textarea, type Tone,
} from './components.ts';
import { sideBySide } from './diff.ts';
import { icon } from './icons.ts';
import { hostPanel, projectPanel, usageCell } from './metrics.ts';
import { type Names, names } from './names.ts';
import type { View } from './view.ts';

type Tab = 'overview' | 'deploys' | 'logs' | 'env' | 'compose' | 'settings';
type Form = Record<string, string>;
type Kind = 'image' | 'compose';

const SAMPLE_COMPOSE = `services:
  app:
    image: localhost:5050/library/hello:latest
    environment:
      DATABASE_URL: \${DATABASE_URL}
    volumes:
      - ./data:/data
`;

/** The string fields of a submitted form. */
export async function readForm(c: Context): Promise<Form> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Form;
}

const opt = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);
const optNull = (v: string | undefined): string | null => opt(v) ?? null;
const int = (v: string | undefined): number | undefined => (v?.trim() ? Number(v.trim()) : undefined);
const checked = (v: string | undefined): boolean => v === 'on' || v === 'true' || v === '1';

/**
 * Parses `KEY=value` lines, as in a .env file. Blank lines and `#` comments
 * are skipped; values are taken literally, without quote handling.
 */
export function parseEnvLines(text: string, secret: boolean): SetEnvInput['set'] {
  const out: SetEnvInput['set'] = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim() === '' || raw.trim().startsWith('#') ? '' : raw.replace(/^\s*export\s+/, '');
    if (!line) return;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new AppError('validation', `Env line ${i + 1}: expected KEY=value`);
    const key = line.slice(0, eq).trim();
    if (key in out) throw new AppError('validation', `Env line ${i + 1}: ${key} is set twice`);
    out[key] = { value: line.slice(eq + 1), secret };
  });
  return out;
}

function envInput(f: Form): SetEnvInput {
  return parseInput(SetEnvInput, {
    set: { ...parseEnvLines(f.env ?? '', false), ...parseEnvLines(f.secretEnv ?? '', true) },
  });
}

const message = (err: unknown): string => {
  if (err instanceof AppError) return err.message;
  console.error(err);
  return 'Something went wrong; see the Vibeship logs.';
};

const TRIGGERS: Record<string, string> = { ui: 'Web UI', api: 'API', mcp: 'MCP', webhook: 'Webhook', recovery: 'Recovery' };
const HEALTH_HELP = 'Polled until it answers 2xx. Empty: healthy while the container runs.';
const NO_HEALTH = 'No health path, healthy while the container runs';
const MEM_HELP = html`For example <code class="inline">512m</code> or <code class="inline">1g</code>. Leave empty for no limit.`;
const OWNER_HELP = 'Set to 1000:1000 for images that run as the node user. Empty: owned by root.';

/** Dashboard, the New project drawer, project pages and the deploy view. */
export function projectPages(deps: { config: Config; services: Services; view: View }): Hono<AppEnv> {
  const { services: s, view } = deps;
  const app = new Hono<AppEnv>();
  const ctx = (c: Context<AppEnv>) => principal(c).ctx;
  const projectByName = (c: Context) => s.projects.getByName(c.req.param('name') ?? '');
  const base = (p: Pick<Project, 'name'>) => `/projects/${p.name}`;

  /** Runs a form action and redirects with a notice, or back with the error. */
  async function act(c: Context<AppEnv>, back: string, run: () => unknown | Promise<unknown>, done: string | ((r: unknown) => string), notice?: string) {
    try {
      const result = await run();
      return view.redirect(c, typeof done === 'string' ? done : done(result), notice ? 'success' : undefined, notice);
    } catch (err) {
      return view.redirect(c, back, 'danger', message(err));
    }
  }

  const registryOptions = () => [
    { value: '', label: 'Matched by host, or anonymous' },
    ...s.registries.list().map((r) => ({ value: String(r.id), label: `${r.name} (${r.host})` })),
  ];

  /** The hostname as an external link with a copy button: shown once, in the project header. */
  const hostLink = (p: Project) => html`<span class="copyable">${externalLink(view.appUrl(p.hostname), p.hostname)}${copyButton(view.appUrl(p.hostname), 'Copy the app URL')}</span>`;

  // Dashboard and the New project drawer

  type NewProject = { kind: Kind; form: Form; error?: string; errors?: FieldErrors };

  const dashboard = (c: Context<AppEnv>, creating?: NewProject) => {
    const projects = s.projects.list();
    const rows = projects.map((p) => ({ p, last: s.deploys.list(p.id, 1)[0] ?? null }));
    const count = (st: string) => projects.filter((p) => p.status === st).length;
    const lastDeploy = rows.map((r) => r.last?.createdAt).filter(Boolean).sort().at(-1);
    const chips = [['all', 'All', projects.length], ...(['running', 'deploying', 'failed', 'stopped'] as const).map((st) => [st, st[0]!.toUpperCase() + st.slice(1), count(st)])] as Array<[string, string, number]>;
    return view.render(c, {
      title: creating ? 'New project' : 'Projects',
      nav: 'projects',
      status: creating?.error ? 400 : 200,
      crumbs: [{ label: 'Projects' }],
      body: html`
        ${pageHeader('Projects', html`<span>Image and compose apps behind Caddy</span>${lastDeploy ? html`<span aria-hidden="true">·</span><span>Last deploy ${ago(lastDeploy)}</span>` : ''}`,
          linkButton('/projects/new', 'New project', { variant: 'primary', icon: 'plus', drawer: 'new-project' }))}
        ${projects.length > 0
          ? html`<div class="filter-bar" data-filter-for="projects-table">
              <input class="input filter-search" type="search" placeholder="Filter by name or hostname" aria-label="Filter projects" data-filter-search />
              <div class="chip-group" role="group" aria-label="Filter by status">
                ${chips.map(([st, label, n]) => html`<button class="chip" type="button" data-filter-status="${st}" aria-pressed="${st === 'all' ? 'true' : 'false'}">${label}<span class="chip-count">${n}</span></button>`)}
              </div>
            </div>`
          : ''}
        ${dataTable({
          id: 'projects-table',
          caption: 'Projects',
          head: ['Name', 'Status', 'Hostname', 'Kind', 'Live version', { label: 'CPU', cls: 'cell-usage' }, { label: 'Memory', cls: 'cell-usage' }, 'Last deploy'],
          body: html`<tbody>
            ${rows.length === 0
              ? emptyRow(8, emptyState('No projects yet', 'Ship a container image or a compose file. Agents can create projects too, over MCP.',
                  linkButton('/projects/new', 'New project', { variant: 'primary', size: 'sm', icon: 'plus', drawer: 'new-project' })))
              : rows.map(({ p, last }) => html`<tr data-filter-row data-name="${p.name} ${p.hostname}" data-status="${p.status}"${p.status === 'deploying' ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>
                <td class="cell-name"><a href="${base(p)}">${p.name}</a></td>
                <td>${statusBadge(p.status)}</td>
                <td class="cell-nowrap">${externalLink(view.appUrl(p.hostname), p.hostname)}</td>
                <td>${tag(p.kind)}</td>
                <td>${liveVersion(p)}</td>
                ${usageCell('data-project', p.name, 'cpu')}
                ${usageCell('data-project', p.name, 'mem')}
                <td>${last ? deployRef(last) : html`<span class="text-subtle">never</span>`}</td>
              </tr>`)}
            <tr class="empty-row" data-filter-empty hidden><td colspan="8" class="text-muted">No projects match. <button class="link-btn" type="button" data-filter-reset>Clear the filter</button></td></tr>
          </tbody>`,
        })}
        ${hostPanel()}
        ${newProjectDrawer(creating)}`,
    });
  };

  const newProjectDrawer = (creating?: NewProject) => {
    const kind = creating?.kind ?? 'image';
    const regs = registryOptions();
    const panel = (k: Kind) => {
      const f = creating?.kind === k ? creating.form : {};
      const e = creating?.kind === k ? creating.errors ?? {} : {};
      const id = (name: string) => `new-${k}-${name}`;
      return html`<form class="form-stack" method="post" action="/projects/new" novalidate data-kind-panel="${k}"${k === kind ? '' : raw(' hidden')}>
        <input type="hidden" name="kind" value="${k}" />
        ${creating?.kind === k && creating.error ? alert('danger', creating.error, 'The project was not created') : ''}
        <div class="form-grid">
          ${field({ label: 'Name', name: 'name', id: id('name'), value: f.name, required: true, mono: true, span: 1, error: e.name, help: 'Lowercase letters, digits and hyphens.' })}
          ${field({ label: 'Hostname', name: 'hostname', id: id('hostname'), value: f.hostname, mono: true, span: 1, error: e.hostname, placeholder: `<name>.${deps.config.baseDomain}`, help: 'Empty: the name on the base domain.' })}
          ${k === 'image'
            ? html`${field({ label: 'Image', name: 'imageRef', id: id('imageRef'), value: f.imageRef, required: true, mono: true, error: e.imageRef, placeholder: 'registry.example.com/library/app:latest', help: 'Without a digest; deploys pin the digest.' })}
              ${field({ label: 'Container port', name: 'containerPort', id: id('containerPort'), value: f.containerPort, type: 'number', required: true, span: 1, error: e.containerPort, placeholder: '8080', attrs: 'min="1" max="65535"' })}
              ${field({ label: 'Health path', name: 'healthPath', id: id('healthPath'), value: f.healthPath, mono: true, span: 1, error: e.healthPath, placeholder: '/health', help: HEALTH_HELP })}
              ${selectField({ label: 'Registry login', name: 'registryId', id: id('registryId'), value: f.registryId, options: regs, error: e.registryId })}
              ${field({ label: 'Memory limit', name: 'memLimit', id: id('memLimit'), value: f.memLimit, mono: true, span: 1, error: e.memLimit, placeholder: '512m', help: MEM_HELP })}
              ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', id: id('dataOwner'), value: f.dataOwner, mono: true, span: 1, error: e.dataOwner, placeholder: '1000:1000', help: OWNER_HELP })}`
            : html`${textarea({ label: 'compose.yaml', name: 'composeYaml', id: id('composeYaml'), value: f.composeYaml ?? SAMPLE_COMPOSE, code: true, rows: 14, required: true, error: e.composeYaml, help: html`No privileged settings, ports only on <code class="inline">127.0.0.1</code>, bind mounts only of <code class="inline">./data</code>. Env vars below reach it as <code class="inline">\${NAME}</code> or with <code class="inline">env_file: .env</code>.` })}
              ${field({ label: 'Routed service', name: 'routedService', id: id('routedService'), value: f.routedService ?? 'app', required: true, mono: true, span: 1, error: e.routedService, help: 'The service Caddy sends traffic to.' })}
              ${field({ label: 'Port', name: 'port', id: id('port'), value: f.port, type: 'number', required: true, span: 1, error: e.port, placeholder: '80', attrs: 'min="1" max="65535"' })}
              ${field({ label: 'Health path', name: 'healthPath', id: id('healthPath'), value: f.healthPath, mono: true, span: 1, error: e.healthPath, placeholder: '/health', help: 'Empty: healthy while the container runs.' })}`}
          ${textarea({ label: 'Env vars', name: 'env', id: id('env'), value: f.env, code: true, rows: 3, placeholder: 'KEY=value', help: 'One KEY=value per line.' })}
          ${textarea({ label: 'Secret env vars', name: 'secretEnv', id: id('secretEnv'), value: '', code: true, rows: 3, placeholder: 'API_KEY=…', help: 'Write-only: they can never be read back. Not kept if the form has an error.' })}
        </div>
        ${checkbox('Deploy right away', 'deploy', f.deploy === undefined || checked(f.deploy))}
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">${icon('plus', 14)}Create project</button>
          <a class="btn btn-ghost" href="/" data-drawer-close>Cancel</a>
        </div>
      </form>`;
    };
    return drawer({
      id: 'new-project',
      title: 'New project',
      wide: true,
      open: Boolean(creating),
      closeHref: '/',
      body: html`
        <div class="segmented" role="group" aria-label="What the app ships as">
          <a href="/projects/new?kind=image" data-kind-switch="image" aria-current="${kind === 'image' ? 'true' : 'false'}">Image</a>
          <a href="/projects/new?kind=compose" data-kind-switch="compose" aria-current="${kind === 'compose' ? 'true' : 'false'}">Compose</a>
        </div>
        <p class="form-note mt-0" data-kind-panel="image"${kind === 'image' ? '' : raw(' hidden')}>One container image from a registry, deployed by digest. CI pushes the image and posts the digest to the project's webhook.</p>
        <p class="form-note mt-0" data-kind-panel="compose"${kind === 'compose' ? '' : raw(' hidden')}>A docker compose file with one routed service and any helpers (a database, a worker), checked against an allowlist.</p>
        ${panel('image')}
        ${panel('compose')}`,
    });
  };

  app.get('/', (c) => dashboard(c));
  // A direct link to the drawer, and where it goes without JS.
  app.get('/projects/new', (c) => dashboard(c, { kind: c.req.query('kind') === 'compose' ? 'compose' : 'image', form: {} }));

  app.post('/projects/new', async (c) => {
    const f = await readForm(c);
    const kind: Kind = f.kind === 'compose' ? 'compose' : 'image';
    try {
      const env = envInput(f);
      const common = { kind: f.kind, name: f.name?.trim(), hostname: opt(f.hostname) };
      const input = kind === 'image'
        ? { ...common, imageRef: f.imageRef?.trim(), containerPort: int(f.containerPort), registryId: int(f.registryId), healthPath: opt(f.healthPath), memLimit: opt(f.memLimit), dataOwner: opt(f.dataOwner) }
        : { ...common, composeYaml: f.composeYaml, routedService: f.routedService?.trim(), port: int(f.port), healthPath: opt(f.healthPath) };
      const project = s.projects.create(ctx(c), input);
      if (Object.keys(env.set).length > 0) s.env.set(ctx(c), project.id, env);
      if (checked(f.deploy)) {
        const d = s.deploys.request(ctx(c), project.id, {}, 'ui');
        return view.redirect(c, `/deploys/${d.id}`, 'success', `Created ${project.name}; deploy #${d.id} is under way.`);
      }
      return view.redirect(c, base(project), 'success', `Created ${project.name}. Deploy it when you are ready.`);
    } catch (err) {
      return dashboard(c, { kind, form: f, error: message(err), errors: fieldErrors(err) });
    }
  });

  // Project pages

  const TABS: Array<[Tab, string]> = [['overview', 'Overview'], ['deploys', 'Deploys'], ['logs', 'Logs'], ['env', 'Env'], ['compose', 'Compose'], ['settings', 'Settings']];

  const shell = (c: Context<AppEnv>, p: Project, tab: Tab, body: Html, status?: 400) => {
    const tabs = TABS.filter(([t]) => t !== 'compose' || p.kind === 'compose');
    const label = tabs.find(([t]) => t === tab)![1];
    const busy = p.status === 'deploying';
    const idle = hasLiveVersion(p) ? undefined : 'Nothing is running yet. Deploy first.';
    return view.render(c, {
      title: tab === 'overview' ? p.name : `${label} · ${p.name}`,
      nav: 'projects',
      status,
      crumbs: [{ label: 'Projects', href: '/' }, { label: p.name, href: base(p) }, ...(tab === 'overview' ? [] : [{ label }])],
      body: html`
        ${pageHeader(
          html`${p.name}<span${busy ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>${statusBadge(p.status)}</span>`,
          html`${hostLink(p)}${tag(p.kind)}`,
          html`
            ${postButton(`${base(p)}/deploy`, busy ? 'Deploying…' : 'Deploy', { variant: 'primary', icon: 'rocket' })}
            ${p.status === 'stopped'
              ? postButton(`${base(p)}/start`, 'Start', { variant: 'secondary' })
              : html`${postButton(`${base(p)}/restart`, 'Restart', { variant: 'secondary', disabledReason: idle })}
                <span class="action-sep" aria-hidden="true"></span>
                ${postButton(`${base(p)}/stop`, 'Stop', {
                  disabledReason: idle,
                  destructive: { title: `Stop ${p.name}?`, body: `${p.hostname} answers 404 until you start it again. Data is kept.`, action: 'Stop' },
                })}`}`,
        )}
        <nav class="tab-list" aria-label="Project sections">
          ${tabs.map(([t, l]) => html`<a class="tab" href="${t === 'overview' ? base(p) : `${base(p)}/${t}`}"${t === tab ? raw(' aria-current="page"') : ''}>${l}</a>`)}
        </nav>
        ${body}`,
    });
  };

  app.get('/projects/:name', async (c) => {
    const p = projectByName(c);
    const n = names(s);
    const drift = s.deploys.drift(p.id);
    let containers: Html;
    try {
      const st = await s.deploys.status(p.id);
      containers = st.containers.length === 0
        ? html`<div class="table-wrap">${emptyState(
            p.status === 'created' ? 'Not deployed yet' : p.status === 'stopped' ? 'Stopped' : 'No containers running',
            p.status === 'created' ? 'Press Deploy above to start the first container.' : p.status === 'stopped' ? 'Press Start above to bring it back.' : 'Nothing is running for this project. The latest deploy log says why.',
          )}</div>`
        : dataTable({
          caption: 'Containers',
          head: ['Container', 'Service', 'State', 'Status', { label: 'CPU', cls: 'cell-usage' }, { label: 'Memory', cls: 'cell-usage' }, { label: 'Net in / out', cls: 'cell-usage' }, { label: 'PIDs', cls: 'cell-usage' }, 'Image'],
          body: html`<tbody>${st.containers.map((ct) => html`<tr>
            <td class="cell-mono">${ct.name}</td>
            <td class="cell-mono">${ct.service}</td>
            <td>${containerState(ct.state)}</td>
            <td class="text-muted">${ct.status}</td>
            ${(['cpu', 'mem', 'net', 'pids'] as const).map((f) => usageCell('data-ct', ct.name, f))}
            <td class="cell-wrap">${copyable(ct.image)}</td>
          </tr>`)}</tbody>`,
        });
    } catch (err) {
      containers = alert('warning', `Could not read containers from Docker: ${(err as Error).message}`);
    }
    const [last] = s.deploys.list(p.id, 1);
    const img = p.image;
    const row = (key: string, value: Html | string) => html`<dt class="props-key">${key}</dt><dd class="props-val">${value}</dd>`;
    return shell(c, p, 'overview', html`
      ${driftAlert(p, drift)}
      ${last?.status === 'failed' ? alert('danger', html`${last.failureReason ?? 'unknown reason'} · <a href="/deploys/${last.id}">deploy #${last.id}</a>`, 'Last deploy failed') : ''}
      ${projectPanel(p.id)}
      <section class="stack" aria-labelledby="containers-title">
        <h2 class="section-title" id="containers-title">Containers</h2>
        ${containers}
      </section>
      <section class="card card-pad" aria-labelledby="details-title">
        <h2 class="card-title" id="details-title">Details</h2>
        <dl class="props">
          ${row('Upstream', copyable(p.upstream))}
          ${row('Live version', p.kind === 'image'
            ? imageVersion(img?.imageRef, img?.currentDigest)
            : p.deployedComposeVersion === null ? html`<span class="text-subtle">none</span>` : html`<a href="${base(p)}/compose/${p.deployedComposeVersion}">Compose v${p.deployedComposeVersion}</a>`)}
          ${img
            ? html`${row('Image', copyable(img.imageRef))}
              ${row('Port', html`<span class="mono">${img.containerPort}</span>`)}
              ${row('Health', img.healthPath ? html`<span class="mono">GET ${img.healthPath}</span>` : NO_HEALTH)}
              ${row('Memory limit', img.memLimit
                ? html`<span class="mono">${img.memLimit}</span>`
                : html`<span>None</span><span class="hint hint-warning">No limit: this app can use all of the VM's memory. <a href="${base(p)}/settings#f-memLimit">Set one</a></span>`)}
              ${row('Data owner', img.dataOwner ? html`<span class="mono">${img.dataOwner}</span>` : html`<span class="mono">root</span><span class="text-muted t-sm">default</span>`)}
              ${row('Webhook', p.hasWebhook ? html`<a href="${base(p)}/settings#webhook">Configured</a>` : html`<span>None</span><a href="${base(p)}/settings#webhook">Create one</a>`)}`
            : html`${row('Latest compose', html`<a href="${base(p)}/compose/${p.compose?.version}">Version ${p.compose?.version}</a><span class="text-muted">routes to</span><span class="mono">${p.compose?.routedService}:${p.compose?.port}</span>`)}
              ${row('Health', p.compose?.healthPath ? html`<span class="mono">GET ${p.compose.healthPath}</span>` : NO_HEALTH)}`}
          ${row('Last deploy', last ? html`${deployRef(last)}<span class="by">by ${n.actor(last.actor, { trigger: last.trigger })}</span>` : html`<span class="text-subtle">never</span>`)}
          ${row('Created', html`${ago(p.createdAt)}<span class="by">by ${n.actor(p.createdBy)}</span>`)}
        </dl>
      </section>`);
  });

  app.get('/projects/:name/deploys', (c) => {
    const p = projectByName(c);
    return shell(c, p, 'deploys', deployTable(s.deploys.list(p.id, 100), composeVersionNumbers(p), names(s)));
  });

  app.get('/projects/:name/logs', async (c) => {
    const p = projectByName(c);
    const container = DeployEngine.routedContainer(p);
    const exists = await s.docker.inspectContainer(container).catch(() => null);
    return shell(c, p, 'logs', exists
      ? html`<div class="log-viewer" data-stream="/api/projects/${p.id}/logs?tail=300">
          <div class="log-viewer-header">
            <strong>Container <span class="mono">${container}</span></strong>
            <span class="log-live" data-live hidden><span class="log-live-dot"></span> connecting</span>
          </div>
          <pre class="log-body" aria-live="polite"></pre>
        </div>
        <p class="text-muted t-sm mt-0">The last 300 lines, then new ones as they arrive.${p.kind === 'compose' ? html` Other services: <code class="inline">docker compose logs</code> on the server, or <code class="inline">get_container_logs</code> over MCP.` : ''}</p>`
      : alert('info', `${p.name} has no container yet; deploy it first.`));
  });

  // Env

  app.get('/projects/:name/env', (c) => {
    const p = projectByName(c);
    const n = names(s);
    const env = s.env.list(p.id);
    return shell(c, p, 'env', html`
      ${dataTable({
        caption: 'Env vars',
        head: ['Key', 'Value', 'Updated', ACTIONS],
        body: html`<tbody>${env.length === 0
          ? emptyRow(4, emptyState('No env vars yet', html`Add <code class="inline">KEY=value</code> lines below, for example <code class="inline">DATABASE_URL=postgres://…</code>. Tick <em>Secret</em> for API keys and passwords.`))
          : env.map((e) => html`<tr>
            <td class="cell-mono">${e.key}</td>
            <td class="cell-mono cell-wrap">${e.isSecret ? html`<span class="text-muted" title="Secret: write-only">••••••••</span> ${tag('secret')}` : e.value}</td>
            <td class="cell-nowrap">${ago(e.updatedAt)} <span class="by">by ${n.actor(e.updatedBy)}</span></td>
            <td class="cell-actions">${postButton(`${base(p)}/env/unset`, 'Remove', {
              size: 'sm', hidden: { key: e.key },
              destructive: { title: `Remove ${e.key}?`, body: `${e.key} is removed from ${p.name}. Running containers keep it until the next deploy.`, action: 'Remove' },
            })}</td>
          </tr>`)}</tbody>`,
      })}
      <form class="card card-pad form-stack form-card" method="post" action="${base(p)}/env" novalidate>
        <h2 class="card-title">Set env vars</h2>
        ${textarea({ label: 'KEY=value lines', name: 'env', rows: 5, code: true, required: true, help: 'Adds or replaces these keys; others are left alone. Changes take effect on the next deploy.' })}
        ${checkbox('Secret (write-only, never shown again)', 'secret')}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>`);
  });

  app.post('/projects/:name/env', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    return act(c, `${base(p)}/env`, () => {
      const set = parseEnvLines(f.env ?? '', checked(f.secret));
      if (Object.keys(set).length === 0) throw new AppError('validation', 'Enter at least one KEY=value line');
      s.env.set(ctx(c), p.id, { set });
    }, `${base(p)}/env`, 'Env saved. Deploy to apply it.');
  });

  app.post('/projects/:name/env/unset', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    return act(c, `${base(p)}/env`, () => s.env.set(ctx(c), p.id, { unset: [f.key ?? ''] }), `${base(p)}/env`, `Removed ${f.key}. Deploy to apply it.`);
  });

  // Compose

  const composePage = (c: Context<AppEnv>, p: Project, f?: Form, error?: string, errors: FieldErrors = {}) => {
    if (p.kind !== 'compose' || !p.compose) throw new AppError('not_found', `${p.name} is not a compose project`);
    const n = names(s);
    const latest = s.projects.getComposeVersion(p.id, p.compose.version);
    const versions = s.projects.listComposeVersions(p.id).slice().reverse();
    const v = f ?? { composeYaml: latest.composeYaml, routedService: latest.routedService, port: String(latest.port), healthPath: latest.healthPath ?? '' };
    return shell(c, p, 'compose', html`
      <form class="card card-pad form-stack" method="post" action="${base(p)}/compose" novalidate>
        <h2 class="card-title">Edit compose.yaml</h2>
        ${error ? alert('danger', error, 'The new version was not saved') : ''}
        ${textarea({ label: 'compose.yaml', name: 'composeYaml', value: v.composeYaml, code: true, rows: 18, required: true, error: errors.composeYaml })}
        <div class="form-grid">
          ${field({ label: 'Routed service', name: 'routedService', value: v.routedService, required: true, mono: true, span: 1, error: errors.routedService })}
          ${field({ label: 'Port', name: 'port', value: v.port, type: 'number', required: true, span: 1, error: errors.port, attrs: 'min="1" max="65535"' })}
          ${field({ label: 'Health path', name: 'healthPath', value: v.healthPath, mono: true, span: 1, error: errors.healthPath, placeholder: '/health' })}
          ${field({ label: 'Note', name: 'note', value: v.note, span: 1, placeholder: 'What changed' })}
        </div>
        ${checkbox('Deploy the new version', 'deploy', true)}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save version ${p.compose.version + 1}</button></div>
      </form>
      <h2 class="section-title">Versions</h2>
      ${dataTable({
        caption: 'Compose versions',
        head: ['Version', 'Routes to', 'Note', 'Saved', 'Changes', ACTIONS],
        body: html`<tbody>${versions.map((cv) => html`<tr>
          <td class="cell-nowrap"><a class="mono" href="${base(p)}/compose/${cv.version}">v${cv.version}</a>${cv.version === p.deployedComposeVersion ? html` ${tag('live')}` : ''}</td>
          <td class="cell-mono">${cv.routedService}:${cv.port}</td>
          <td class="cell-wrap">${cv.note ?? ''}</td>
          <td class="cell-nowrap">${ago(cv.createdAt)} <span class="by">by ${n.actor(cv.createdBy)}</span></td>
          <td>${cv.version > 1 ? html`<a href="${base(p)}/compose/${cv.version}#diff">diff v${cv.version - 1}</a>` : html`<span class="text-subtle">first</span>`}</td>
          <td class="cell-actions">${postButton(`${base(p)}/deploy`, 'Deploy', {
            variant: 'secondary', size: 'sm', hidden: { composeVersion: String(cv.version) },
            confirm: { title: `Deploy version ${cv.version}?`, body: `${p.name} switches to compose version ${cv.version}.`, action: 'Deploy' },
          })}</td>
        </tr>`)}</tbody>`,
      })}`, error ? 400 : undefined);
  };

  app.get('/projects/:name/compose', (c) => composePage(c, projectByName(c)));

  app.get('/projects/:name/compose/:version', (c) => {
    const p = projectByName(c);
    const num = Number(c.req.param('version'));
    if (!Number.isInteger(num) || num < 1) throw new AppError('not_found', 'Compose version not found');
    const cv = s.projects.getComposeVersion(p.id, num);
    const prev = num > 1 ? s.projects.getComposeVersion(p.id, num - 1) : null;
    const row = (key: string, value: Html | string) => html`<dt class="props-key">${key}</dt><dd class="props-val">${value}</dd>`;
    return shell(c, p, 'compose', html`
      <section class="card card-pad">
        <dl class="props">
          ${row('Version', html`${cv.version}${cv.version === p.deployedComposeVersion ? html` ${tag('live')}` : ''}`)}
          ${row('Routes to', html`<span class="mono">${cv.routedService}:${cv.port}</span>`)}
          ${row('Health', cv.healthPath ? html`<span class="mono">GET ${cv.healthPath}</span>` : NO_HEALTH)}
          ${row('Note', cv.note ?? html`<span class="text-subtle">none</span>`)}
          ${row('Saved', html`${ago(cv.createdAt)}<span class="by">by ${names(s).actor(cv.createdBy)}</span>`)}
        </dl>
      </section>
      ${prev ? composeDiff(prev.version, prev.composeYaml, cv.version, cv.composeYaml) : html`<pre class="pre-block">${cv.composeYaml}</pre>`}
      <div class="form-actions">
        ${postButton(`${base(p)}/deploy`, `Deploy version ${cv.version}`, { variant: 'primary', hidden: { composeVersion: String(cv.version) } })}
        <a class="btn btn-ghost" href="${base(p)}/compose">All versions</a>
      </div>`);
  });

  app.post('/projects/:name/compose', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    try {
      const cv = s.projects.addComposeVersion(ctx(c), p.id, {
        composeYaml: f.composeYaml, routedService: f.routedService?.trim(), port: int(f.port), healthPath: opt(f.healthPath), note: opt(f.note),
      });
      if (checked(f.deploy)) {
        const d = s.deploys.request(ctx(c), p.id, { composeVersion: cv.version }, 'ui');
        return view.redirect(c, `/deploys/${d.id}`, 'success', `Saved compose version ${cv.version}; deploy #${d.id} is under way.`);
      }
      return view.redirect(c, `${base(p)}/compose`, 'success', `Saved compose version ${cv.version}.`);
    } catch (err) {
      return composePage(c, p, f, message(err), fieldErrors(err));
    }
  });

  // Settings

  const settingsPage = (c: Context<AppEnv>, p: Project, opts: { form?: Form; error?: string; errors?: FieldErrors; webhookUrl?: string } = {}) => {
    const f = opts.form ?? {
      hostname: p.hostname,
      imageRef: p.image?.imageRef ?? '',
      containerPort: String(p.image?.containerPort ?? ''),
      registryId: p.image?.registryId ? String(p.image.registryId) : '',
      healthPath: p.image?.healthPath ?? '',
      memLimit: p.image?.memLimit ?? '',
      dataOwner: p.image?.dataOwner ?? '',
    };
    const e = opts.errors ?? {};
    const drift = s.deploys.drift(p.id);
    const payload = '{"digest": "sha256:…"}';
    return shell(c, p, 'settings', html`
      ${driftAlert(p, drift)}
      <form class="card card-pad form-stack form-card" method="post" action="${base(p)}/settings" novalidate>
        <h2 class="card-title">Project</h2>
        ${opts.error ? alert('danger', opts.error, 'Not saved') : ''}
        <div class="form-grid">
          ${field({ label: 'Hostname', name: 'hostname', value: f.hostname, required: true, mono: true, error: e.hostname, help: 'Changes the route once deployed.' })}
          ${p.kind === 'image'
            ? html`${field({ label: 'Image', name: 'imageRef', value: f.imageRef, required: true, mono: true, error: e.imageRef, help: 'Without a digest; deploys pin the digest.' })}
              ${selectField({ label: 'Registry login', name: 'registryId', value: f.registryId, options: registryOptions(), error: e.registryId })}
              ${field({ label: 'Container port', name: 'containerPort', value: f.containerPort, type: 'number', required: true, span: 1, error: e.containerPort, attrs: 'min="1" max="65535"' })}
              ${field({ label: 'Health path', name: 'healthPath', value: f.healthPath, mono: true, span: 1, error: e.healthPath, placeholder: '/health', help: HEALTH_HELP })}
              ${field({ label: 'Memory limit', name: 'memLimit', value: f.memLimit, mono: true, span: 1, error: e.memLimit, placeholder: '512m', help: MEM_HELP })}
              ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', value: f.dataOwner, mono: true, span: 1, error: e.dataOwner, placeholder: '1000:1000', help: OWNER_HELP })}`
            : ''}
        </div>
        ${p.kind === 'compose' ? html`<p class="form-note mt-0">The compose file, routed service and port change on the <a href="${base(p)}/compose">Compose</a> tab.</p>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Save</button>
          <button class="btn btn-secondary" type="submit" name="deploy" value="1">${icon('rocket', 14)}Save &amp; deploy</button>
          <span class="form-note">Save takes effect on the next deploy.</span>
        </div>
      </form>
      ${p.kind === 'image'
        ? html`<section class="card card-pad form-stack form-card" id="webhook" aria-labelledby="webhook-title">
            <h2 class="card-title" id="webhook-title">Deploy webhook</h2>
            <p class="form-note mt-0">After pushing the image, CI posts the new digest to this URL (see <code class="inline">examples/github-actions/deploy.yml</code>). Anyone with the URL can deploy, but only digests of <span class="mono">${p.image?.imageRef}</span>.</p>
            <div>
              <div class="label">Example body</div>
              <div class="code-block"><pre>${payload}</pre>${copyButton(payload, 'Copy the example body')}</div>
            </div>
            ${opts.webhookUrl ? shownOnce('Webhook URL', opts.webhookUrl, 'Store it as a CI secret now; it cannot be shown again.') : ''}
            <div class="form-actions">
              ${postButton(`${base(p)}/webhook`, p.hasWebhook ? 'Rotate webhook URL' : 'Create webhook URL', {
                variant: 'secondary',
                confirm: p.hasWebhook ? { title: 'Rotate the webhook URL?', body: 'A new URL is created and the old one stops working at once. Update the CI secret afterwards.', action: 'Rotate' } : undefined,
              })}
              <span class="form-note">${p.hasWebhook ? 'A webhook URL is set. Rotating makes a new one and the old URL stops working at once.' : 'No webhook yet.'}</span>
            </div>
          </section>`
        : ''}
      <form class="card card-pad is-danger form-stack form-card" method="post" action="${base(p)}/delete" novalidate${confirmAttrs({
        title: `Delete ${p.name}?`, body: 'Stops the containers and removes the route, files and history. This cannot be undone.', action: `Delete ${p.name}`, tone: 'danger',
      })}>
        <h2 class="card-title">Delete project</h2>
        <p class="form-note mt-0">Stops the containers and removes the route, files and history. <span class="mono">data/</span> and named volumes are kept unless you tick the box.</p>
        ${checkbox('Also delete data/ and named volumes', 'deleteData')}
        <div class="form-grid">
          ${field({ label: `Type ${p.name} to confirm`, labelHtml: html`Type <code class="inline">${p.name}</code> to confirm`, name: 'confirmName', mono: true, required: true, attrs: `autocomplete="off" spellcheck="false" data-confirm-name="${p.name}"` })}
        </div>
        <div class="form-actions"><button class="btn btn-danger" type="submit" data-confirm-target>${icon('trash', 14)}Delete ${p.name}</button><span class="form-note">This cannot be undone.</span></div>
      </form>`, opts.error ? 400 : undefined);
  };

  app.get('/projects/:name/settings', (c) => settingsPage(c, projectByName(c)));

  app.post('/projects/:name/settings', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    let updated: Project;
    try {
      const changes = p.kind === 'image'
        ? {
            hostname: f.hostname?.trim(), imageRef: f.imageRef?.trim(), containerPort: int(f.containerPort),
            registryId: int(f.registryId) ?? null, healthPath: optNull(f.healthPath), memLimit: optNull(f.memLimit),
            dataOwner: optNull(f.dataOwner),
          }
        : { hostname: f.hostname?.trim() };
      updated = s.projects.update(ctx(c), p.id, changes);
    } catch (err) {
      return settingsPage(c, p, { form: f, error: message(err), errors: fieldErrors(err) });
    }
    if (f.deploy !== '1') return view.redirect(c, `${base(updated)}/settings`, 'success', 'Saved. Deploy to apply it.');
    return act(c, `${base(updated)}/settings`, () => s.deploys.request(ctx(c), updated.id, {}, 'ui'),
      (d) => `/deploys/${(d as Deploy).id}`, 'Saved; the deploy is under way.');
  });

  app.post('/projects/:name/webhook', (c) => {
    const p = projectByName(c);
    try {
      const { token, project } = s.projects.rotateWebhook(ctx(c), p.id);
      return settingsPage(c, project, { webhookUrl: `${view.publicUrl}/hooks/deploy/${token}` });
    } catch (err) {
      return view.redirect(c, `${base(p)}/settings`, 'danger', message(err));
    }
  });

  app.post('/projects/:name/delete', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    if (f.confirmName?.trim() !== p.name) {
      return view.redirect(c, `${base(p)}/settings`, 'danger', `Type ${p.name} exactly to delete it.`);
    }
    const deleteData = checked(f.deleteData);
    return act(c, `${base(p)}/settings`, () => s.deploys.removeProject(ctx(c), p.id, { deleteData }), '/',
      `Deleted ${p.name}${deleteData ? ' and its data' : '; its data/ folder and volumes were kept'}.`);
  });

  // Deploys and lifecycle

  app.post('/projects/:name/deploy', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    return act(c, base(p), () => s.deploys.request(ctx(c), p.id, { composeVersion: int(f.composeVersion), digest: opt(f.digest) }, 'ui'),
      (d) => `/deploys/${(d as Deploy).id}`);
  });

  for (const action of ['stop', 'start', 'restart'] as const) {
    app.post(`/projects/:name/${action}`, (c) => {
      const p = projectByName(c);
      const done = { stop: 'Stopped', start: 'Started', restart: 'Restarted' }[action];
      return act(c, base(p), () => s.deploys.lifecycle(ctx(c), p.id, action), base(p), `${done} ${p.name}.`);
    });
  }

  app.get('/deploys/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) throw new AppError('not_found', 'Deploy not found');
    const d = s.deploys.get(id);
    const p = s.projects.get(d.projectId);
    const lines = s.deploys.logs(d.id, 0);
    const finished = d.status === 'healthy' || d.status === 'failed';
    const lastSeq = lines.at(-1)?.seq ?? 0;
    const version = p.kind === 'compose' ? composeVersionNumbers(p).get(d.composeVersionId ?? -1) : null;
    const row = (key: string, value: Html | string) => html`<dt class="props-key">${key}</dt><dd class="props-val">${value}</dd>`;
    return view.render(c, {
      title: `Deploy #${d.id}`,
      nav: 'projects',
      crumbs: [{ label: 'Projects', href: '/' }, { label: p.name, href: base(p) }, { label: 'Deploys', href: `${base(p)}/deploys` }, { label: `Deploy #${d.id}` }],
      body: html`
        ${pageHeader(html`Deploy #${d.id} ${statusBadge(d.status, { kind: 'deploy' })}`,
          html`<a href="${base(p)}">${p.name}</a><span aria-hidden="true">·</span><span>${TRIGGERS[d.trigger] ?? d.trigger} by ${names(s).actor(d.actor, { trigger: d.trigger })}</span><span aria-hidden="true">·</span>${ago(d.createdAt)}`,
          html`${finished ? postButton(`${base(p)}/deploy`, 'Deploy again', { variant: 'primary', icon: 'rocket' }) : ''}
            ${linkButton(`${base(p)}/deploys`, 'All deploys', { variant: 'secondary' })}`)}
        ${d.status === 'failed' ? alert('danger', d.failureReason ?? 'unknown reason', 'Deploy failed') : ''}
        ${d.status === 'healthy' ? alert('success', html`${externalLink(view.appUrl(p.hostname), p.hostname)} is serving this version.`, 'Live') : ''}
        <section class="card card-pad">
          <dl class="props">
            ${row('Version', p.kind === 'image'
              ? d.digest ? copyable(d.digest) : 'latest for the tag'
              : version ? html`<a href="${base(p)}/compose/${version}">Compose version ${version}</a>` : 'unknown')}
            ${row('Queued', ago(d.createdAt))}
            ${row('Took', duration(d.startedAt, d.finishedAt) || (finished ? html`<span class="text-subtle">—</span>` : 'still going'))}
          </dl>
        </section>
        <div class="log-viewer"${finished ? '' : raw(` data-stream="/api/deploys/${d.id}/logs?after=${lastSeq}"`)}>
          <div class="log-viewer-header">
            <strong>Deploy log</strong>
            <span class="log-live" data-live hidden><span class="log-live-dot"></span> connecting</span>
          </div>
          <pre class="log-body" aria-live="polite">${lines.map((l) => html`<div class="log-line"><span class="log-num">${l.seq}</span><span class="log-ts" title="${absoluteTime(l.ts)}">${l.ts.slice(11, 19)}</span><span class="${lineClass(l.stream, l.line)}">${l.line}</span></div>`)}</pre>
        </div>`,
    });
  });

  // Helpers needing services

  function composeVersionNumbers(p: Project): Map<number, number> {
    return new Map(p.kind === 'compose' ? s.projects.listComposeVersions(p.id).map((v) => [v.id, v.version]) : []);
  }

  return app;
}

/**
 * Line colours: Vibeship's own failure lines in red, the go-live line in
 * green. stderr isn't red, since compose writes its progress there.
 */
export function lineClass(stream: string, line: string): string {
  if (stream === 'system' && /^(Deploy failed|Could not|No earlier)/.test(line)) return 'log-err';
  if (stream === 'system' && /is live$|serving again$/.test(line)) return 'log-ok';
  return 'log-out';
}

/** Whether a version has ever gone live, so there is something to restart or stop. */
function hasLiveVersion(p: Project): boolean {
  return p.kind === 'image' ? Boolean(p.image?.currentDigest) : p.deployedComposeVersion !== null;
}

/** A Docker container state as a status: running is success, restarting warning, dead danger, the rest neutral. */
function containerState(state: string): Html {
  const tones: Record<string, Tone> = { running: 'success', restarting: 'warning', dead: 'danger' };
  return statusBadge(state, { tone: tones[state] ?? 'neutral', label: state[0]!.toUpperCase() + state.slice(1) });
}

/** "#12 · Healthy · 5m ago", in a fixed layout so rows line up. */
function deployRef(d: Deploy): Html {
  return html`<span class="deploy-ref"><a href="/deploys/${d.id}" title="deploy:${d.id}">#${d.id}</a>${statusBadge(d.status, { kind: 'deploy' })}${ago(d.createdAt)}</span>`;
}

/** The tag and a 7-character digest for an image; the compose version for compose. */
function liveVersion(p: Project): Html {
  if (p.kind === 'image') return imageVersion(p.image?.imageRef, p.image?.currentDigest);
  return p.deployedComposeVersion === null ? html`<span class="text-subtle">none</span>` : html`Compose v${p.deployedComposeVersion}`;
}

/** Two-column diff of a compose version against the one before it. */
function composeDiff(beforeNo: number, before: string, afterNo: number, after: string): Html {
  const rows = sideBySide(before, after);
  const changed = rows.filter((r) => r.kind === 'change');
  const added = changed.filter((r) => r.kind === 'change' && r.right !== null).length;
  const removed = changed.filter((r) => r.kind === 'change' && r.left !== null).length;
  const cell = (no: number | null, text: string | null, cls: string) =>
    html`<span class="diff-no">${no ?? ''}</span><span class="diff-text ${text === null ? 'diff-blank' : cls}">${text ?? ''}</span>`;
  return html`<div class="diff" id="diff">
    <div class="diff-header">
      <strong>Changes from v${beforeNo}</strong>
      <span class="diff-stats">${changed.length === 0 ? html`<span class="text-muted">identical</span>` : html`<span class="diff-stat-add">+${added}</span> <span class="diff-stat-del">−${removed}</span>`}</span>
    </div>
    <div class="diff-cols"><div>v${beforeNo}</div><div>v${afterNo}</div></div>
    <div class="diff-body">${rows.map((r) => r.kind === 'fold'
      ? html`<div class="diff-fold">⋯ ${r.count} unchanged line${r.count === 1 ? '' : 's'}</div>`
      : r.kind === 'same'
        ? html`<div class="diff-row">${cell(r.leftNo, r.left, '')}${cell(r.rightNo, r.right, '')}</div>`
        : html`<div class="diff-row">${cell(r.leftNo, r.left, 'diff-del')}${cell(r.rightNo, r.right, 'diff-add')}</div>`)}</div>
  </div>`;
}

function driftAlert(p: Project, drift: { files: Array<{ path: string; state: string }>; pendingChanges: boolean }): Html {
  const edited = drift.files.filter((f) => f.state !== 'ok');
  return html`
    ${edited.length > 0
      ? alert('warning', html`${edited.map((f, i) => html`${i > 0 ? ', ' : ''}<span class="mono">${f.path}</span> (${f.state})`)} in the project folder differ from what Vibeship wrote. The next deploy overwrites them.`, 'Drift detected')
      : ''}
    ${drift.pendingChanges && p.status !== 'deploying'
      ? alert('info', 'Env or settings changed since the last deploy. Deploy to apply them.', 'Changes waiting')
      : ''}`;
}

function deployTable(deploys: Deploy[], versions: Map<number, number>, n: Names): Html {
  return dataTable({
    caption: 'Deploys',
    head: ['Deploy', 'Status', 'Trigger', 'Version', 'By', 'Queued', 'Took', 'Reason'],
    body: html`<tbody>${deploys.length === 0
      ? emptyRow(8, emptyState('No deploys yet', html`Press <strong>Deploy</strong> above, or let CI post to the project's webhook.`))
      : deploys.map((d) => html`<tr>
        <td><a class="mono" href="/deploys/${d.id}">#${d.id}</a></td>
        <td>${statusBadge(d.status, { kind: 'deploy' })}</td>
        <td>${TRIGGERS[d.trigger] ?? d.trigger}</td>
        <td class="cell-nowrap">${d.composeVersionId !== null ? html`<span class="mono">v${versions.get(d.composeVersionId) ?? '?'}</span>` : shortDigest(d.digest)}</td>
        <td>${n.actor(d.actor, { trigger: d.trigger })}</td>
        <td class="cell-nowrap">${ago(d.createdAt)}</td>
        <td class="cell-num">${duration(d.startedAt, d.finishedAt)}</td>
        <td class="cell-wrap">${d.failureReason ?? ''}</td>
      </tr>`)}</tbody>`,
  });
}
