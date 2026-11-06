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
  absoluteTime, ACTIONS, ago, alert, checkbox, confirmAttrs, copyable, copyButton, dataTable, duration, emptyRow, emptyState, externalLink, field,
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
const HEALTH_HELP = 'Empty: healthy while the container stays up.';
const NO_HEALTH = 'No health path. Healthy while the container stays up.';
const MEM_HELP = 'Empty: no limit. Use m or g, like 512m or 1g.';
const OWNER_HELP = 'Use 1000:1000 for images that run as the node user. Empty: owned by root.';
const REGISTRY_HELP = 'Auto picks the login whose host matches the image.';

/** Dashboard, the New project page, project pages and the deploy view. */
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

  /** "Auto: match image host", then each login as "Repoflow · api.repoflow.io". */
  const registryOptions = () => [
    { value: '', label: 'Auto: match image host' },
    ...s.registries.list().map((r) => ({ value: String(r.id), label: `${r.name} · ${r.host}` })),
  ];

  /** The hostname as an external link with a copy button: shown once, in the project header. */
  const hostLink = (p: Project) => html`<span class="copyable">${externalLink(view.appUrl(p.hostname), p.hostname)}${copyButton(view.appUrl(p.hostname), 'Copy hostname')}</span>`;

  /** The "⋯" menu at the end of a project row. */
  const rowMenu = (p: Project) => html`<details class="dropdown">
    <summary class="btn-icon" aria-label="More actions for ${p.name}">${icon('more', 18)}</summary>
    <div class="dropdown-menu">
      <a class="dropdown-item" href="${base(p)}">Overview</a>
      <a class="dropdown-item" href="${base(p)}/deploys">Deploys</a>
      <a class="dropdown-item" href="${base(p)}/logs">Logs</a>
      <a class="dropdown-item" href="${base(p)}/settings">Settings</a>
      <div class="dropdown-sep"></div>
      <form method="post" action="${base(p)}/deploy"><button class="dropdown-item" type="submit">${icon('deploy', 16)}Deploy</button></form>
    </div>
  </details>`;

  // Dashboard and the New project page

  type NewProject = { kind: Kind; form: Form; error?: string; errors?: FieldErrors };

  const dashboard = (c: Context<AppEnv>) => {
    const projects = s.projects.list();
    const rows = projects.map((p) => ({ p, last: s.deploys.list(p.id, 1)[0] ?? null }));
    const count = (st: string) => projects.filter((p) => p.status === st).length;
    const lastDeploy = rows.map((r) => r.last?.createdAt).filter(Boolean).sort().at(-1);
    const chips = [['all', 'All', projects.length], ...(['running', 'deploying', 'failed', 'stopped'] as const).map((st) => [st, st[0]!.toUpperCase() + st.slice(1), count(st)])] as Array<[string, string, number]>;
    return view.render(c, {
      title: 'Projects',
      nav: 'projects',
      crumbs: [{ label: 'Projects' }],
      body: html`
        ${pageHeader('Projects', html`<span>Image and compose apps served behind Caddy${lastDeploy ? html` · last deploy ${ago(lastDeploy)}` : ''}</span>`,
          linkButton('/projects/new', 'New project', { variant: 'primary', icon: 'plus' }))}
        ${hostPanel()}
        <div class="stack">
          ${projects.length > 0
            ? html`<div class="filter-bar" data-filter-for="projects-table">
                <div class="search">${icon('search', 18)}<label class="sr-only" for="project-filter">Filter projects</label><input class="input input-ui" id="project-filter" type="search" placeholder="Filter by name or hostname" data-filter-search /></div>
                <div class="chip-group" role="group" aria-label="Filter by status">
                  ${chips.map(([st, label, n]) => html`<button class="chip" type="button" data-filter-status="${st}" aria-pressed="${st === 'all' ? 'true' : 'false'}">${label}<span class="chip-count">${n}</span></button>`)}
                </div>
              </div>`
            : ''}
          ${dataTable({
            id: 'projects-table',
            caption: 'Projects',
            head: ['Name', 'Status', 'Health', 'Hostname', 'Kind', 'Version', { label: 'CPU', cls: 'cell-usage' }, { label: 'Memory', cls: 'cell-usage' }, 'Last deploy', ACTIONS],
            body: html`<tbody>
              ${rows.length === 0
                ? emptyRow(10, emptyState('No projects yet', 'Ship a container image or a compose file. Agents can create projects too, over MCP.',
                    linkButton('/projects/new', 'New project', { variant: 'primary', size: 'sm', icon: 'plus' })))
                : rows.map(({ p, last }) => html`<tr data-filter-row data-name="${p.name} ${p.hostname}" data-status="${p.status}"${p.status === 'deploying' ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>
                  <td class="cell-name cell-nowrap"><a href="${base(p)}">${p.name}</a></td>
                  <td>${statusBadge(p.status)}</td>
                  <td>${last ? statusBadge(last.status, { kind: 'deploy' }) : html`<span class="text-subtle">—</span>`}</td>
                  <td class="cell-host">${externalLink(view.appUrl(p.hostname), p.hostname)}</td>
                  <td>${tag(p.kind)}</td>
                  <td>${liveVersion(p)}</td>
                  ${usageCell('data-project', p.name, 'cpu')}
                  ${usageCell('data-project', p.name, 'mem')}
                  <td>${last ? deployRef(last) : html`<span class="text-subtle">never</span>`}</td>
                  <td class="cell-actions">${rowMenu(p)}</td>
                </tr>`)}
              <tr class="empty-row" data-filter-empty hidden><td colspan="10" class="text-muted">No projects match. <button class="link-btn" type="button" data-filter-reset>Clear the filter</button></td></tr>
            </tbody>`,
          })}
        </div>`,
    });
  };

  const KINDS: Array<[Kind, string, string]> = [
    ['image', 'Image', 'One container image from a registry, deployed by digest. CI pushes the image and posts the digest to the webhook.'],
    ['compose', 'Compose', 'A docker compose file with one routed service and any helpers (a database, a worker), checked against an allowlist.'],
  ];

  /** The New project page: pick the kind, then one form per kind, in cards like Settings. */
  const newProject = (c: Context<AppEnv>, creating: NewProject) => {
    const kind = creating.kind;
    const regs = registryOptions();
    const panel = (k: Kind) => {
      const f = kind === k ? creating.form : {};
      const e = kind === k ? creating.errors ?? {} : {};
      const id = (name: string) => `new-${k}-${name}`;
      return html`<form class="form-page" method="post" action="/projects/new" novalidate data-kind-panel="${k}"${k === kind ? '' : raw(' hidden')}>
        <input type="hidden" name="kind" value="${k}" />
        ${kind === k && creating.error ? alert('danger', creating.error, 'The project was not created') : ''}
        <section class="card" aria-labelledby="${id('project-title')}">
          <div class="card-head">
            <h2 class="card-title" id="${id('project-title')}">Project</h2>
            <p class="card-description">Its name, and the hostname Caddy serves it on.</p>
          </div>
          <div class="card-body"><div class="form-grid">
            ${field({ label: 'Name', name: 'name', id: id('name'), value: f.name, required: true, span: 4, error: e.name, help: 'Lowercase letters, digits and hyphens.' })}
            ${field({ label: 'Hostname', name: 'hostname', id: id('hostname'), value: f.hostname, span: 8, error: e.hostname, placeholder: `e.g. <name>.${deps.config.baseDomain}`, help: 'Empty: the name on the base domain.' })}
          </div></div>
        </section>
        ${k === 'image'
          ? html`<section class="card" aria-labelledby="${id('container-title')}">
              <div class="card-head">
                <h2 class="card-title" id="${id('container-title')}">Container</h2>
                <p class="card-description">What it pulls, the port it listens on, and how it is checked.</p>
              </div>
              <div class="card-body"><div class="form-grid">
                ${field({ label: 'Image', name: 'imageRef', id: id('imageRef'), value: f.imageRef, required: true, span: 8, error: e.imageRef, placeholder: 'e.g. registry.example.com/library/app:latest', help: 'Full image reference including tag.' })}
                ${selectField({ label: 'Registry login', name: 'registryId', id: id('registryId'), value: f.registryId, options: regs, span: 4, error: e.registryId, help: REGISTRY_HELP })}
                ${field({ label: 'Container port', name: 'containerPort', id: id('containerPort'), value: f.containerPort, type: 'number', required: true, span: 2, error: e.containerPort, placeholder: 'e.g. 8080', attrs: 'min="1" max="65535" inputmode="numeric"' })}
                ${field({ label: 'Health path', name: 'healthPath', id: id('healthPath'), value: f.healthPath, span: 3, error: e.healthPath, placeholder: 'e.g. /health', help: HEALTH_HELP })}
                ${field({ label: 'Memory limit', name: 'memLimit', id: id('memLimit'), value: f.memLimit, span: 3, error: e.memLimit, placeholder: 'e.g. 512m', help: MEM_HELP })}
                ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', id: id('dataOwner'), value: f.dataOwner, span: 4, error: e.dataOwner, placeholder: 'e.g. 1000:1000', help: OWNER_HELP })}
              </div></div>
            </section>`
          : html`<section class="card" aria-labelledby="${id('compose-title')}">
              <div class="card-head">
                <h2 class="card-title" id="${id('compose-title')}">Compose file</h2>
                <p class="card-description">No privileged settings, ports only on <code class="inline">127.0.0.1</code>, bind mounts only of <code class="inline">./data</code>.</p>
              </div>
              <div class="card-body"><div class="form-grid">
                ${textarea({ label: 'compose.yaml', name: 'composeYaml', id: id('composeYaml'), value: f.composeYaml ?? SAMPLE_COMPOSE, code: true, rows: 16, required: true, span: 12, error: e.composeYaml, help: html`Env vars below reach it as <code class="inline">\${NAME}</code> or with <code class="inline">env_file: .env</code>.` })}
                ${field({ label: 'Routed service', name: 'routedService', id: id('routedService'), value: f.routedService ?? 'app', required: true, span: 4, error: e.routedService, help: 'The service Caddy sends traffic to.' })}
                ${field({ label: 'Port', name: 'port', id: id('port'), value: f.port, type: 'number', required: true, span: 4, error: e.port, placeholder: 'e.g. 80', attrs: 'min="1" max="65535" inputmode="numeric"' })}
                ${field({ label: 'Health path', name: 'healthPath', id: id('healthPath'), value: f.healthPath, span: 4, error: e.healthPath, placeholder: 'e.g. /health', help: HEALTH_HELP })}
              </div></div>
            </section>`}
        <section class="card" aria-labelledby="${id('env-title')}">
          <div class="card-head">
            <h2 class="card-title" id="${id('env-title')}">Env vars</h2>
            <p class="card-description">Optional. You can change them later on the Env tab.</p>
          </div>
          <div class="card-body"><div class="form-grid">
            ${textarea({ label: 'Env vars', name: 'env', id: id('env'), value: f.env, code: true, rows: 5, span: 6, placeholder: 'KEY=value', help: 'One KEY=value per line.' })}
            ${textarea({ label: 'Secret env vars', name: 'secretEnv', id: id('secretEnv'), value: '', code: true, rows: 5, span: 6, placeholder: 'API_KEY=…', help: 'Write-only: they can never be read back. Not kept if the form has an error.' })}
          </div></div>
          <div class="card-footer">
            <button class="btn btn-primary" type="submit">${icon('plus', 16)}Create project</button>
            <a class="btn btn-ghost" href="/">Cancel</a>
            ${checkbox('Deploy right away', 'deploy', f.deploy === undefined || checked(f.deploy))}
          </div>
        </section>
      </form>`;
    };
    return view.render(c, {
      title: 'New project',
      nav: 'projects',
      status: creating.error ? 400 : 200,
      crumbs: [{ label: 'Projects', href: '/' }, { label: 'New project' }],
      body: html`
        ${pageHeader('New project', 'Ship a container image or a compose file. Agents can create projects too, over MCP.')}
        <div class="kind-options" role="group" aria-label="What the app ships as">
          ${KINDS.map(([k, label, desc]) => html`<a class="kind-option" href="/projects/new?kind=${k}" data-kind-switch="${k}" aria-current="${k === kind ? 'true' : 'false'}">
            <span class="kind-option-radio" aria-hidden="true"></span>
            <span class="kind-option-title">${label}</span>
            <span class="kind-option-desc">${desc}</span>
          </a>`)}
        </div>
        ${panel('image')}
        ${panel('compose')}`,
    });
  };

  app.get('/', (c) => dashboard(c));
  app.get('/projects/new', (c) => newProject(c, { kind: c.req.query('kind') === 'compose' ? 'compose' : 'image', form: {} }));

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
      return newProject(c, { kind, form: f, error: message(err), errors: fieldErrors(err) });
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
      crumbs: [{ label: 'Projects', href: '/' }, { label: p.name }],
      body: html`
        <div>
          ${pageHeader(
            html`${p.name}<span${busy ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>${statusBadge(p.status)}</span>`,
            html`${hostLink(p)}${tag(p.kind)}`,
            html`
              ${postButton(`${base(p)}/deploy`, busy ? 'Deploying…' : 'Deploy', { variant: 'primary', icon: 'deploy' })}
              ${p.status === 'stopped'
                ? postButton(`${base(p)}/start`, 'Start', { variant: 'secondary' })
                : html`${postButton(`${base(p)}/restart`, 'Restart', { variant: 'secondary', disabledReason: idle })}
                  <span class="action-sep" aria-hidden="true"></span>
                  ${postButton(`${base(p)}/stop`, 'Stop…', {
                    disabledReason: idle,
                    destructive: { title: `Stop ${p.name}?`, body: `${p.hostname} answers 404 until you start it again. Data is kept.`, action: 'Stop' },
                  })}`}`,
            { project: true },
          )}
          <nav class="tab-list project-tabs" aria-label="Project sections">
            ${tabs.map(([t, l]) => html`<a class="tab" href="${t === 'overview' ? base(p) : `${base(p)}/${t}`}"${t === tab ? raw(' aria-current="page"') : ''}>${l}</a>`)}
          </nav>
        </div>
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
            <td class="cell-quiet">${ct.status}</td>
            ${(['cpu', 'mem', 'net', 'pids'] as const).map((f) => usageCell('data-ct', ct.name, f))}
            <td class="cell-wrap"><span class="mono t-sm" title="${ct.image}">${shortImage(ct.image)}</span></td>
          </tr>`)}</tbody>`,
        });
    } catch (err) {
      containers = alert('warning', `Could not read containers from Docker: ${(err as Error).message}`);
    }
    const [last] = s.deploys.list(p.id, 1);
    const img = p.image;
    const reg = img?.registryId ? safeRegistry(img.registryId) : null;
    const item = (key: string, value: Html | string) => html`<div><dt>${key}</dt><dd>${value}</dd></div>`;
    const settings = `${base(p)}/settings`;
    const noLimit = img && !img.memLimit ? html`<a class="status tone-warning" href="${settings}#f-memLimit"><span class="status-dot" aria-hidden="true"></span>No limit</a>` : undefined;
    return shell(c, p, 'overview', html`
      ${driftAlert(p, drift)}
      ${last?.status === 'failed' ? alert('danger', html`${last.failureReason ?? 'unknown reason'} · <a href="/deploys/${last.id}">deploy #${last.id}</a>`, 'Last deploy failed') : ''}
      ${projectPanel(p.id, noLimit)}
      <section class="stack" aria-labelledby="containers-title">
        <h2 class="section-title" id="containers-title">Containers</h2>
        ${containers}
      </section>
      <section class="stack" aria-labelledby="details-title">
        <h2 class="section-title" id="details-title">Details</h2>
        <div class="card detail-groups">
          <div class="detail-group">
            <h3 class="detail-group-title">Version</h3>
            <dl class="dl">
              ${item('Live version', p.kind === 'image'
                ? imageVersion(img?.imageRef, img?.currentDigest)
                : p.deployedComposeVersion === null ? html`<span class="text-subtle">none</span>` : html`<a href="${base(p)}/compose/${p.deployedComposeVersion}">Compose v${p.deployedComposeVersion}</a>`)}
              ${img ? item('Image', copyable(img.imageRef)) : item('Latest compose', html`<a href="${base(p)}/compose/${p.compose?.version}">Version ${p.compose?.version}</a>`)}
              ${item('Last deploy', last
                ? html`<a class="mono" href="/deploys/${last.id}" title="deploy:${last.id}">#${last.id}</a>${statusBadge(last.status, { kind: 'deploy' })}<span class="by">${ago(last.createdAt)} by ${n.actor(last.actor, { trigger: last.trigger })}</span>`
                : html`<span class="text-subtle">never</span>`)}
              ${item('Created', html`${ago(p.createdAt)}<span class="by">by ${n.actor(p.createdBy)}</span>`)}
            </dl>
          </div>
          <div class="detail-group">
            <h3 class="detail-group-title">Routing</h3>
            <dl class="dl">
              ${item('Upstream', copyable(p.upstream))}
              ${img
                ? html`${item('Container port', html`<span class="mono">${img.containerPort}</span>`)}
                  ${item('Registry login', reg ? html`${reg.name} <span class="mono text-muted">${reg.host}</span>` : 'Auto: matched by image host')}
                  ${item('Deploy webhook', p.hasWebhook
                    ? html`${statusBadge('configured', { label: 'Configured', tone: 'success' })}<a href="${settings}#webhook">Manage</a>`
                    : html`${statusBadge('none', { label: 'Not set', tone: 'neutral' })}<a href="${settings}#webhook">Create one</a>`)}`
                : item('Routes to', html`<span class="mono">${p.compose?.routedService}:${p.compose?.port}</span>`)}
            </dl>
          </div>
          <div class="detail-group">
            <h3 class="detail-group-title">Runtime</h3>
            <dl class="dl">
              ${(() => {
                const path = img ? img.healthPath : p.compose?.healthPath;
                return item('Health check', path ? html`<span class="mono">GET ${path}</span>` : html`${NO_HEALTH} <a href="${img ? settings : `${base(p)}/compose`}">Add a health path</a>`);
              })()}
              ${img
                ? html`${item('Memory limit', img.memLimit ? html`<span class="mono">${img.memLimit}</span>` : html`None <a href="${settings}#f-memLimit">Set a limit</a>`)}
                  ${item('Data owner', img.dataOwner ? html`<span class="mono">${img.dataOwner}</span>` : html`<span class="mono">root</span><span class="text-muted">(default)</span>`)}`
                : ''}
            </dl>
          </div>
        </div>
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
            <td class="cell-actions">${postButton(`${base(p)}/env/unset`, 'Remove…', {
              variant: 'ghost-danger', size: 'sm', hidden: { key: e.key },
              destructive: { title: `Remove ${e.key}?`, body: `${e.key} is removed from ${p.name}. Running containers keep it until the next deploy.`, action: 'Remove' },
            })}</td>
          </tr>`)}</tbody>`,
      })}
      <form class="card" method="post" action="${base(p)}/env" novalidate>
        <div class="card-head"><h2 class="card-title">Set env vars</h2><p class="card-description">Adds or replaces these keys; others are left alone.</p></div>
        <div class="card-body">
          ${textarea({ label: 'KEY=value lines', name: 'env', rows: 5, code: true, required: true, placeholder: 'DATABASE_URL=postgres://…' })}
          ${checkbox('Secret (write-only, never shown again)', 'secret')}
        </div>
        <div class="card-footer"><button class="btn btn-primary" type="submit">Save</button><span class="form-note">Changes take effect on the next deploy.</span></div>
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
      <form class="card" method="post" action="${base(p)}/compose" novalidate>
        <div class="card-head"><h2 class="card-title">Edit compose.yaml</h2><p class="card-description">Saving makes version ${p.compose.version + 1}; earlier versions stay below.</p></div>
        <div class="card-body">
          ${error ? alert('danger', error, 'The new version was not saved') : ''}
          ${textarea({ label: 'compose.yaml', name: 'composeYaml', value: v.composeYaml, code: true, rows: 18, required: true, error: errors.composeYaml })}
          <div class="form-grid">
            ${field({ label: 'Routed service', name: 'routedService', value: v.routedService, required: true, span: 3, error: errors.routedService })}
            ${field({ label: 'Port', name: 'port', value: v.port, type: 'number', required: true, span: 2, error: errors.port, attrs: 'min="1" max="65535" inputmode="numeric"' })}
            ${field({ label: 'Health path', name: 'healthPath', value: v.healthPath, span: 3, error: errors.healthPath, placeholder: 'e.g. /health' })}
            ${field({ label: 'Note', name: 'note', value: v.note, span: 4, mono: false, placeholder: 'What changed' })}
          </div>
          ${checkbox('Deploy the new version', 'deploy', true)}
        </div>
        <div class="card-footer"><button class="btn btn-primary" type="submit">Save version ${p.compose.version + 1}</button></div>
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
    const img = p.image;
    return shell(c, p, 'settings', html`
      ${driftAlert(p, drift)}
      <form class="card" method="post" action="${base(p)}/settings" novalidate aria-labelledby="project-title">
        <div class="card-head">
          <h2 class="card-title" id="project-title">Project</h2>
          <p class="card-description">${p.kind === 'image' ? 'Where it runs, what it pulls, and how it is checked.' : html`Where it runs. The compose file, routed service and port change on the <a href="${base(p)}/compose">Compose</a> tab.`}</p>
        </div>
        <div class="card-body">
          ${opts.error ? alert('danger', opts.error, 'Not saved') : ''}
          <div class="form-grid">
            ${field({ label: 'Hostname', name: 'hostname', value: f.hostname, required: true, span: 4, error: e.hostname, help: 'Public route. Changes after the next deploy.' })}
            ${p.kind === 'image'
              ? html`${field({ label: 'Image', name: 'imageRef', value: f.imageRef, required: true, span: 8, error: e.imageRef, help: 'Full image reference including tag.' })}
                ${selectField({ label: 'Registry login', name: 'registryId', value: f.registryId, options: registryOptions(), span: 4, error: e.registryId, help: REGISTRY_HELP })}
                ${field({ label: 'Container port', name: 'containerPort', value: f.containerPort, type: 'number', required: true, span: 2, error: e.containerPort, attrs: 'min="1" max="65535" inputmode="numeric"' })}
                ${field({ label: 'Health path', name: 'healthPath', value: f.healthPath, span: 3, error: e.healthPath, placeholder: 'e.g. /health', help: HEALTH_HELP })}
                ${field({ label: 'Memory limit', name: 'memLimit', value: f.memLimit, span: 3, error: e.memLimit, placeholder: 'e.g. 512m', help: MEM_HELP })}
                ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', value: f.dataOwner, span: 4, error: e.dataOwner, placeholder: 'e.g. 1000:1000', help: OWNER_HELP })}`
              : ''}
          </div>
        </div>
        <div class="card-footer">
          <button class="btn btn-primary" type="submit">Save</button>
          <button class="btn btn-secondary" type="submit" name="deploy" value="1">Save &amp; deploy</button>
          <span class="form-note">Saved changes take effect on the next deploy.</span>
        </div>
      </form>
      ${img
        ? html`<section class="card" id="webhook" aria-labelledby="webhook-title">
            <div class="card-body">
              <h2 class="card-title" id="webhook-title">Deploy webhook ${p.hasWebhook ? statusBadge('configured', { label: 'Configured', tone: 'success' }) : statusBadge('none', { label: 'Not set', tone: 'neutral' })}</h2>
              <p class="card-text">After CI pushes a new image, it posts the digest to the webhook URL. Anyone holding the URL can trigger a deploy, but only for digests of the allowed image.</p>
              ${opts.webhookUrl ? shownOnce('Webhook URL', opts.webhookUrl, 'Store it as a CI secret now; it cannot be shown again.') : ''}
              <div class="form-grid">
                <div>
                  <div class="code-head"><span class="label">Request body</span>${copyButton(payload, 'Copy request body')}</div>
                  <pre class="code">${payload}</pre>
                  <p class="field-help">Example workflow: <span class="mono">examples/github-actions/deploy.yml</span></p>
                </div>
                <div>
                  <div class="label code-head">Allowed image</div>
                  ${copyable(img.imageRef)}
                </div>
              </div>
            </div>
            <div class="card-footer">
              ${postButton(`${base(p)}/webhook`, p.hasWebhook ? 'Rotate webhook URL…' : 'Create webhook URL', {
                variant: 'secondary',
                confirm: p.hasWebhook ? { title: 'Rotate the webhook URL?', body: 'The current URL stops working immediately. Update the CI secret with the new one, which is shown once.', action: 'Rotate' } : undefined,
              })}
              <span class="form-note">${p.hasWebhook ? 'The current URL stops working immediately. The new one is shown once.' : 'The URL is shown once, when it is created.'}</span>
            </div>
          </section>`
        : ''}
      <form class="card is-danger" method="post" action="${base(p)}/delete" novalidate aria-labelledby="delete-title"${confirmAttrs({
        title: `Delete ${p.name}?`, body: 'Stops the containers and removes the route, files and deploy history. This cannot be undone.', action: 'Delete project', tone: 'danger',
      })}>
        <div class="card-body">
          <h2 class="card-title" id="delete-title">Delete project</h2>
          <p class="card-text">Stops the containers and removes the route, files and deploy history. <span class="mono">data/</span> and named volumes are kept unless you choose otherwise.</p>
          ${checkbox(html`Also delete <span class="mono">data/</span> and named volumes`, 'deleteData', false, { danger: true })}
          <div class="form-grid">
            ${field({ label: `Type ${p.name} to confirm`, labelHtml: html`Type <code class="inline">${p.name}</code> to confirm`, name: 'confirmName', required: true, span: 4, attrs: `autocomplete="off" spellcheck="false" data-confirm-name="${p.name}"` })}
          </div>
          <div><button class="btn btn-danger-solid" type="submit" data-confirm-target>Delete project…</button></div>
        </div>
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
          html`${finished ? postButton(`${base(p)}/deploy`, 'Deploy again', { variant: 'primary', icon: 'deploy' }) : ''}
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

  function safeRegistry(id: number) {
    try {
      return s.registries.get(id);
    } catch {
      return null; // deleted since
    }
  }

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

/**
 * "…/vibes/app:latest" or "…/library/hello@e2e9fc0": the last two path
 * parts and a 7-character digest; the whole reference goes in the tooltip.
 */
function shortImage(ref: string): string {
  const [name = ref, digest] = ref.split('@');
  const parts = name.split('/');
  const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : name;
  return digest ? `${short}@${digest.replace(/^sha256:/, '').slice(0, 7)}` : short;
}

/** A Docker container state as a status: running is success, restarting warning, dead danger, the rest neutral. */
function containerState(state: string): Html {
  const tones: Record<string, Tone> = { running: 'success', restarting: 'warning', dead: 'danger' };
  return statusBadge(state, { tone: tones[state] ?? 'neutral', label: state[0]!.toUpperCase() + state.slice(1) });
}

/** "#12 · 5m ago": the deploy's outcome has its own Health column. */
function deployRef(d: Deploy): Html {
  return html`<span class="deploy-ref"><a href="/deploys/${d.id}" title="deploy:${d.id}">#${d.id}</a> · ${ago(d.createdAt)}</span>`;
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
