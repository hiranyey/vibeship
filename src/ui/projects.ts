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
  ago, alert, copyable, copyButton, duration, emptyRow, field, type Html, pageHeader, pill, postButton, shortDigest, shownOnce, textarea, type View,
} from './view.ts';
import { sideBySide } from './diff.ts';
import { icon } from './icons.ts';
import { hostPanel, projectPanel, usageCell } from './metrics.ts';

type Tab = 'overview' | 'deploys' | 'logs' | 'env' | 'compose' | 'settings';
type Form = Record<string, string>;

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

/** Dashboard, new project wizard, project pages and the deploy view. */
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

  // Dashboard

  app.get('/', (c) => {
    const projects = s.projects.list();
    const rows = projects.map((p) => ({ p, last: s.deploys.list(p.id, 1)[0] ?? null }));
    const count = (st: string) => projects.filter((p) => p.status === st).length;
    const lastDeploy = rows.map((r) => r.last?.createdAt).filter(Boolean).sort().at(-1);
    return view.render(c, {
      title: 'Projects',
      nav: 'projects',
      crumbs: [{ label: 'Projects' }],
      body: html`
        ${pageHeader('Projects', 'Image and compose apps behind Caddy', html`<a class="btn btn-primary" href="/projects/new">${icon('plus', 14)}New project</a>`)}
        <div class="stat-strip">
          <div class="stat"><div class="stat-label">Projects</div><div class="stat-value">${projects.length}</div></div>
          <div class="stat"><div class="stat-label">Running</div><div class="stat-value">${count('running')}</div></div>
          <div class="stat"><div class="stat-label">Failed</div><div class="stat-value">${count('failed')}</div></div>
          <div class="stat"><div class="stat-label">Last deploy</div><div class="stat-value t-lg">${ago(lastDeploy)}</div></div>
        </div>
        ${hostPanel()}
        ${projects.length > 0
          ? html`<div class="filter-bar" data-filter-for="projects-table">
              <input class="input filter-search" type="search" placeholder="Filter by name or hostname" aria-label="Filter projects" data-filter-search />
              <div class="chip-group" role="group" aria-label="Filter by status">
                ${(['all', 'running', 'deploying', 'failed', 'stopped'] as const).map((st) => html`<button class="chip${st === 'all' ? ' is-active' : ''}" type="button" data-filter-status="${st}" aria-pressed="${st === 'all' ? 'true' : 'false'}">${st === 'all' ? 'All' : st}<span class="chip-count">${st === 'all' ? projects.length : count(st)}</span></button>`)}
              </div>
            </div>`
          : ''}
        <div class="table-wrap">
          <table class="table" id="projects-table">
            <thead><tr><th>Name</th><th>Status</th><th>Hostname</th><th>Kind</th><th>Live version</th><th class="cell-usage">CPU</th><th class="cell-usage">Memory</th><th>Last deploy</th></tr></thead>
            <tbody>
              ${rows.length === 0
                ? emptyRow(8, html`<div class="empty-state">
                    <div class="empty-title">No projects yet</div>
                    <p>Ship a container image or a compose file. Agents can create projects too, over MCP.</p>
                    <a class="btn btn-primary btn-sm" href="/projects/new">${icon('plus', 14)}New project</a>
                  </div>`)
                : rows.map(({ p, last }) => html`<tr data-filter-row data-name="${p.name} ${p.hostname}" data-status="${p.status}"${p.status === 'deploying' ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>
                  <td class="cell-name"><a href="${base(p)}">${p.name}</a></td>
                  <td>${pill(p.status)}</td>
                  <td class="cell-mono"><a href="${view.appUrl(p.hostname)}" rel="noopener noreferrer" target="_blank">${p.hostname}</a></td>
                  <td><span class="badge">${p.kind}</span></td>
                  <td class="cell-mono">${liveVersion(p)}</td>
                  ${usageCell('data-project', p.name, 'cpu')}
                  ${usageCell('data-project', p.name, 'mem')}
                  <td>${last ? html`<a href="/deploys/${last.id}">#${last.id}</a> ${pill(last.status, 'deploy')} ${ago(last.createdAt)}` : html`<span class="text-subtle">never</span>`}</td>
                </tr>`)}
              <tr class="empty-row" data-filter-empty hidden><td colspan="8" class="text-muted">No projects match. <button class="link-btn" type="button" data-filter-reset>Clear the filter</button></td></tr>
            </tbody>
          </table>
        </div>`,
    });
  });

  // New project wizard

  const wizard = (c: Context<AppEnv>, kind: string | undefined, f: Form = {}, error?: string) => {
    if (kind !== 'image' && kind !== 'compose') {
      return view.render(c, {
        title: 'New project',
        nav: 'projects',
        crumbs: [{ label: 'Projects', href: '/' }, { label: 'New project' }],
        body: html`${pageHeader('New project', 'What does the app ship as?')}
          <div class="kind-choice">
            <a href="/projects/new?kind=image"><div class="card card-pad">
              <div class="card-title">Image</div>
              <p class="text-muted t-sm">One container image from a registry, deployed by digest. CI pushes the image and posts the digest to the project's webhook.</p>
            </div></a>
            <a href="/projects/new?kind=compose"><div class="card card-pad">
              <div class="card-title">Compose</div>
              <p class="text-muted t-sm">A docker compose file with one routed service and any helpers (a database, a worker), checked against an allowlist.</p>
            </div></a>
          </div>`,
      });
    }
    const registries = s.registries.list();
    return view.render(c, {
      title: `New ${kind} project`,
      nav: 'projects',
      status: error ? 400 : 200,
      crumbs: [{ label: 'Projects', href: '/' }, { label: 'New project', href: '/projects/new' }, { label: kind }],
      body: html`${pageHeader(`New ${kind} project`, kind === 'image' ? 'A container image from a registry' : 'A docker compose file')}
        ${error ? alert('danger', error, 'The project was not created') : ''}
        <form class="form-stack" method="post" action="/projects/new">
          <input type="hidden" name="kind" value="${kind}" />
          <div class="form-grid">
            ${field({ label: 'Name', name: 'name', value: f.name, required: true, mono: true, help: 'Lowercase letters, digits and hyphens. Used for the folder, the container and the default hostname.' })}
            ${field({ label: 'Hostname', name: 'hostname', value: f.hostname, mono: true, placeholder: `<name>.${deps.config.baseDomain}`, help: 'Leave empty for <name> on the base domain.' })}
          </div>
          ${kind === 'image'
            ? html`<div class="form-grid">
                ${field({ label: 'Image', name: 'imageRef', value: f.imageRef, required: true, mono: true, placeholder: 'registry.example.com/library/app:latest', help: 'Without a digest; deploys pin the digest.' })}
                ${field({ label: 'Container port', name: 'containerPort', value: f.containerPort, type: 'number', required: true, attrs: 'min="1" max="65535"' })}
                <div class="field">
                  <label class="field-label" for="f-registryId">Registry login</label>
                  <select class="select" id="f-registryId" name="registryId">
                    <option value="">Matched by host, or anonymous</option>
                    ${registries.map((r) => html`<option value="${r.id}"${String(r.id) === f.registryId ? raw(' selected') : ''}>${r.name} (${r.host})</option>`)}
                  </select>
                </div>
                ${field({ label: 'Health path', name: 'healthPath', value: f.healthPath, mono: true, placeholder: '/health', help: 'Answers 2xx when healthy. Empty: the container just has to stay up.' })}
                ${field({ label: 'Memory limit', name: 'memLimit', value: f.memLimit, mono: true, placeholder: '512m' })}
                ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', value: f.dataOwner, mono: true, placeholder: '1000:1000', help: 'Set to 1000:1000 for images that run as the node user. Empty: owned by root.' })}
              </div>`
            : html`${textarea({ label: 'compose.yaml', name: 'composeYaml', value: f.composeYaml ?? SAMPLE_COMPOSE, yaml: true, rows: 16, help: html`No privileged settings, ports only on <code class="inline">127.0.0.1</code>, bind mounts only of <code class="inline">./data</code>. Env vars below reach it as <code class="inline">\${NAME}</code> or with <code class="inline">env_file: .env</code>.` })}
              <div class="form-grid">
                ${field({ label: 'Routed service', name: 'routedService', value: f.routedService ?? 'app', required: true, mono: true, help: 'The service Caddy sends traffic to.' })}
                ${field({ label: 'Port', name: 'port', value: f.port, type: 'number', required: true, attrs: 'min="1" max="65535"' })}
                ${field({ label: 'Health path', name: 'healthPath', value: f.healthPath, mono: true, placeholder: '/health' })}
              </div>`}
          <div class="form-grid">
            ${textarea({ label: 'Env vars', name: 'env', value: f.env, rows: 4, placeholder: 'KEY=value', help: 'One KEY=value per line.' })}
            ${textarea({ label: 'Secret env vars', name: 'secretEnv', value: '', rows: 4, placeholder: 'API_KEY=…', help: 'Write-only: they can never be read back. Not kept if the form has an error.' })}
          </div>
          <label class="checkbox"><input type="checkbox" name="deploy"${f.deploy === undefined || checked(f.deploy) ? raw(' checked') : ''} /> Deploy right away</label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">${icon('plus', 14)}Create project</button>
            <a class="btn btn-ghost" href="/projects/new">Back</a>
          </div>
        </form>`,
    });
  };

  app.get('/projects/new', (c) => wizard(c, c.req.query('kind')));

  app.post('/projects/new', async (c) => {
    const f = await readForm(c);
    try {
      const env = envInput(f);
      const common = { kind: f.kind, name: f.name?.trim(), hostname: opt(f.hostname) };
      const input = f.kind === 'image'
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
      return wizard(c, f.kind, f, message(err));
    }
  });

  // Project pages

  const shell = (c: Context<AppEnv>, p: Project, tab: Tab, body: Html, status?: 400) => {
    const tabs: Array<[Tab, string]> = [
      ['overview', 'Overview'], ['deploys', 'Deploys'], ['logs', 'Logs'], ['env', 'Env'],
      ...(p.kind === 'compose' ? [['compose', 'Compose'] as [Tab, string]] : []),
      ['settings', 'Settings'],
    ];
    const busy = p.status === 'deploying';
    return view.render(c, {
      title: p.name,
      nav: 'projects',
      status,
      crumbs: [{ label: 'Projects', href: '/' }, { label: p.name, href: base(p) }, ...(tab === 'overview' ? [] : [{ label: tab }])],
      body: html`
        ${pageHeader(html`${p.name} <span${busy ? html` data-watch="/api/projects/${p.id}" data-watch-status="deploying"` : ''}>${pill(p.status)}</span>`, html`<a class="mono" href="${view.appUrl(p.hostname)}" rel="noopener noreferrer" target="_blank">${p.hostname}</a>${copyButton(view.appUrl(p.hostname), 'Copy the app URL')} · ${p.kind}`, html`
          ${postButton(`${base(p)}/deploy`, busy ? 'Deploying…' : 'Deploy', { cls: 'btn-primary', icon: 'rocket' })}
          ${p.status === 'stopped'
            ? postButton(`${base(p)}/start`, 'Start')
            : html`${postButton(`${base(p)}/restart`, 'Restart')}${postButton(`${base(p)}/stop`, 'Stop', { confirm: `Stop ${p.name}? Its hostname answers 404 until you start it.` })}`}
        `)}
        <nav class="tab-list" aria-label="Project sections">
          ${tabs.map(([t, label]) => html`<a class="tab" href="${t === 'overview' ? base(p) : `${base(p)}/${t}`}" aria-selected="${t === tab ? 'true' : 'false'}"${t === tab ? raw(' aria-current="page"') : ''}>${label}</a>`)}
        </nav>
        ${body}`,
    });
  };

  app.get('/projects/:name', async (c) => {
    const p = projectByName(c);
    const drift = s.deploys.drift(p.id);
    let containers: Html;
    try {
      const st = await s.deploys.status(p.id);
      containers = html`<table class="table">
        <thead><tr><th>Container</th><th>Service</th><th>State</th><th>Status</th><th class="cell-usage">CPU</th><th class="cell-usage">Memory</th><th class="cell-usage">Net in / out</th><th class="cell-usage">PIDs</th><th>Image</th></tr></thead>
        <tbody>${st.containers.length === 0
          ? emptyRow(9, p.status === 'created' ? 'Not deployed yet.' : 'No containers.')
          : st.containers.map((ct) => html`<tr><td class="cell-mono">${ct.name}</td><td class="cell-mono">${ct.service}</td><td>${ct.state}</td><td>${ct.status}</td>${
            (['cpu', 'mem', 'net', 'pids'] as const).map((f) => usageCell('data-ct', ct.name, f))
          }<td class="cell-mono cell-wrap">${ct.image}</td></tr>`)}</tbody>
      </table>`;
    } catch (err) {
      containers = alert('warning', `Could not read containers from Docker: ${(err as Error).message}`);
    }
    const [last] = s.deploys.list(p.id, 1);
    return shell(c, p, 'overview', html`
      ${driftAlert(p, drift)}
      ${last?.status === 'failed' ? alert('danger', html`${last.failureReason ?? 'unknown reason'} · <a href="/deploys/${last.id}">deploy #${last.id}</a>`, 'Last deploy failed') : ''}
      ${projectPanel(p.id)}
      <div class="card card-pad">
        <div class="props">
          <div class="props-key">Hostname</div><div class="props-val">${copyable(p.hostname)}</div>
          <div class="props-key">Upstream</div><div class="props-val">${copyable(p.upstream)}</div>
          <div class="props-key">Live version</div><div class="props-val mono">${liveVersion(p, true)}</div>
          ${p.image
            ? html`<div class="props-key">Image</div><div class="props-val">${copyable(p.image.imageRef)}</div>
              <div class="props-key">Port</div><div class="props-val mono">${p.image.containerPort}</div>
              <div class="props-key">Health</div><div class="props-val mono">${p.image.healthPath ? `GET ${p.image.healthPath}` : 'container stays up'}</div>
              <div class="props-key">Memory limit</div><div class="props-val mono">${p.image.memLimit ?? 'none'}</div>
              <div class="props-key">Data owner</div><div class="props-val mono">${p.image.dataOwner ?? 'root'}</div>
              <div class="props-key">Webhook</div><div class="props-val">${p.hasWebhook ? 'configured' : html`none · <a href="${base(p)}/settings">create one</a>`}</div>`
            : html`<div class="props-key">Latest compose</div><div class="props-val">version ${p.compose?.version} · routes to <span class="mono">${p.compose?.routedService}:${p.compose?.port}</span></div>
              <div class="props-key">Health</div><div class="props-val mono">${p.compose?.healthPath ? `GET ${p.compose.healthPath}` : 'container stays up'}</div>`}
          <div class="props-key">Last deploy</div><div class="props-val">${last ? html`<a href="/deploys/${last.id}">#${last.id}</a> ${pill(last.status, 'deploy')} ${ago(last.createdAt)} by ${last.actor}` : 'never'}</div>
          <div class="props-key">Created</div><div class="props-val">${ago(p.createdAt)} by ${p.createdBy}</div>
        </div>
      </div>
      <h2 class="section-title">Containers</h2>
      <div class="table-wrap">${containers}</div>`);
  });

  app.get('/projects/:name/deploys', (c) => {
    const p = projectByName(c);
    const versions = composeVersionNumbers(p);
    return shell(c, p, 'deploys', html`<div class="table-wrap">${deployTable(s.deploys.list(p.id, 100), versions)}</div>`);
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
          <pre class="log-body log-tall" aria-live="polite"></pre>
        </div>
        <p class="text-muted t-sm">The last 300 lines, then new ones as they arrive.${p.kind === 'compose' ? ' Other services: docker compose logs on the server, or get_container_logs over MCP.' : ''}</p>`
      : alert('info', `${p.name} has no container yet; deploy it first.`));
  });

  // Env

  app.get('/projects/:name/env', (c) => {
    const p = projectByName(c);
    const env = s.env.list(p.id);
    return shell(c, p, 'env', html`
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr></thead>
          <tbody>${env.length === 0
            ? emptyRow(4, html`<div class="empty-state">
                <div class="empty-title">No env vars yet</div>
                <p>Add <code class="inline">KEY=value</code> lines below, for example <code class="inline">DATABASE_URL=postgres://…</code>. Tick <em>Secret</em> for API keys and passwords.</p>
              </div>`)
            : env.map((e) => html`<tr>
              <td class="cell-mono">${e.key}</td>
              <td class="cell-mono cell-wrap">${e.isSecret ? html`<span class="env-secret" title="Secret: write-only">••••••••</span> <span class="badge">secret</span>` : e.value}</td>
              <td>${ago(e.updatedAt)} by ${e.updatedBy}</td>
              <td class="cell-actions">${postButton(`${base(p)}/env/unset`, 'Remove', { cls: 'btn-ghost btn-sm', hidden: { key: e.key }, confirm: `Remove ${e.key}?` })}</td>
            </tr>`)}</tbody>
        </table>
      </div>
      <form class="card card-pad form-stack" method="post" action="${base(p)}/env">
        <h2 class="section-title">Set env vars</h2>
        ${textarea({ label: 'KEY=value lines', name: 'env', rows: 5, help: 'Adds or replaces these keys; others are left alone. Changes take effect on the next deploy.' })}
        <label class="checkbox"><input type="checkbox" name="secret" /> Secret (write-only, never shown again)</label>
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

  const composePage = (c: Context<AppEnv>, p: Project, f?: Form, error?: string) => {
    if (p.kind !== 'compose' || !p.compose) throw new AppError('not_found', `${p.name} is not a compose project`);
    const latest = s.projects.getComposeVersion(p.id, p.compose.version);
    const versions = s.projects.listComposeVersions(p.id).slice().reverse();
    const v = f ?? { composeYaml: latest.composeYaml, routedService: latest.routedService, port: String(latest.port), healthPath: latest.healthPath ?? '' };
    return shell(c, p, 'compose', html`
      ${error ? alert('danger', error, 'The new version was not saved') : ''}
      <form class="card card-pad form-stack" method="post" action="${base(p)}/compose">
        <h2 class="section-title">Edit compose.yaml</h2>
        ${textarea({ label: 'compose.yaml', name: 'composeYaml', value: v.composeYaml, yaml: true, rows: 18 })}
        <div class="form-grid">
          ${field({ label: 'Routed service', name: 'routedService', value: v.routedService, required: true, mono: true })}
          ${field({ label: 'Port', name: 'port', value: v.port, type: 'number', required: true })}
          ${field({ label: 'Health path', name: 'healthPath', value: v.healthPath, mono: true })}
          ${field({ label: 'Note', name: 'note', value: v.note, placeholder: 'What changed' })}
        </div>
        <label class="checkbox"><input type="checkbox" name="deploy" checked /> Deploy the new version</label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save version ${p.compose.version + 1}</button></div>
      </form>
      <h2 class="section-title">Versions</h2>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Version</th><th>Routes to</th><th>Note</th><th>Saved</th><th>Changes</th><th></th></tr></thead>
          <tbody>${versions.map((cv) => html`<tr>
            <td><a href="${base(p)}/compose/${cv.version}">v${cv.version}</a>${cv.version === p.deployedComposeVersion ? html` <span class="badge">live</span>` : ''}</td>
            <td class="cell-mono">${cv.routedService}:${cv.port}</td>
            <td class="cell-wrap">${cv.note ?? ''}</td>
            <td>${ago(cv.createdAt)} by ${cv.createdBy}</td>
            <td>${cv.version > 1 ? html`<a href="${base(p)}/compose/${cv.version}#diff">diff v${cv.version - 1}</a>` : html`<span class="text-subtle">first</span>`}</td>
            <td class="cell-actions">${postButton(`${base(p)}/deploy`, 'Deploy', { cls: 'btn-secondary btn-sm', hidden: { composeVersion: String(cv.version) }, confirm: `Deploy compose version ${cv.version} of ${p.name}?` })}</td>
          </tr>`)}</tbody>
        </table>
      </div>`, error ? 400 : undefined);
  };

  app.get('/projects/:name/compose', (c) => composePage(c, projectByName(c)));

  app.get('/projects/:name/compose/:version', (c) => {
    const p = projectByName(c);
    const n = Number(c.req.param('version'));
    if (!Number.isInteger(n) || n < 1) throw new AppError('not_found', 'Compose version not found');
    const cv = s.projects.getComposeVersion(p.id, n);
    const prev = n > 1 ? s.projects.getComposeVersion(p.id, n - 1) : null;
    return shell(c, p, 'compose', html`
      <div class="card card-pad">
        <div class="props">
          <div class="props-key">Version</div><div class="props-val">${cv.version}${cv.version === p.deployedComposeVersion ? ' (live)' : ''}</div>
          <div class="props-key">Routes to</div><div class="props-val mono">${cv.routedService}:${cv.port}</div>
          <div class="props-key">Health</div><div class="props-val mono">${cv.healthPath ?? 'container stays up'}</div>
          <div class="props-key">Note</div><div class="props-val">${cv.note ?? ''}</div>
          <div class="props-key">Saved</div><div class="props-val">${ago(cv.createdAt)} by ${cv.createdBy}</div>
        </div>
      </div>
      ${prev ? composeDiff(prev.version, prev.composeYaml, cv.version, cv.composeYaml) : html`<pre class="pre-block pre-yaml">${cv.composeYaml}</pre>`}
      <div class="row">
        ${postButton(`${base(p)}/deploy`, `Deploy version ${cv.version}`, { cls: 'btn-primary', hidden: { composeVersion: String(cv.version) } })}
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
      return composePage(c, p, f, message(err));
    }
  });

  // Settings

  const settingsPage = (c: Context<AppEnv>, p: Project, opts: { form?: Form; error?: string; webhookUrl?: string } = {}) => {
    const f = opts.form ?? {
      hostname: p.hostname,
      imageRef: p.image?.imageRef ?? '',
      containerPort: String(p.image?.containerPort ?? ''),
      registryId: p.image?.registryId ? String(p.image.registryId) : '',
      healthPath: p.image?.healthPath ?? '',
      memLimit: p.image?.memLimit ?? '',
      dataOwner: p.image?.dataOwner ?? '',
    };
    const registries = s.registries.list();
    const drift = s.deploys.drift(p.id);
    return shell(c, p, 'settings', html`
      ${opts.error ? alert('danger', opts.error, 'Not saved') : ''}
      ${driftAlert(p, drift)}
      <form class="card card-pad form-stack" method="post" action="${base(p)}/settings">
        <h2 class="section-title">Project</h2>
        <div class="form-grid">
          ${field({ label: 'Hostname', name: 'hostname', value: f.hostname, required: true, mono: true, help: 'Changes the route once deployed.' })}
          ${p.kind === 'image'
            ? html`${field({ label: 'Image', name: 'imageRef', value: f.imageRef, required: true, mono: true })}
              ${field({ label: 'Container port', name: 'containerPort', value: f.containerPort, type: 'number', required: true })}
              <div class="field">
                <label class="field-label" for="f-registryId">Registry login</label>
                <select class="select" id="f-registryId" name="registryId">
                  <option value="">Matched by host, or anonymous</option>
                  ${registries.map((r) => html`<option value="${r.id}"${String(r.id) === f.registryId ? raw(' selected') : ''}>${r.name} (${r.host})</option>`)}
                </select>
              </div>
              ${field({ label: 'Health path', name: 'healthPath', value: f.healthPath, mono: true, placeholder: '/health' })}
              ${field({ label: 'Memory limit', name: 'memLimit', value: f.memLimit, mono: true, placeholder: '512m' })}
              ${field({ label: 'Data owner (uid:gid)', name: 'dataOwner', value: f.dataOwner, mono: true, placeholder: '1000:1000', help: 'Set to 1000:1000 for images that run as the node user. Empty: owned by root.' })}`
            : ''}
        </div>
        ${p.kind === 'compose' ? html`<p class="text-muted t-sm mt-0">The compose file, routed service and port change on the <a href="${base(p)}/compose">Compose</a> tab.</p>` : ''}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><span class="text-muted t-sm">Takes effect on the next deploy.</span></div>
      </form>
      ${p.kind === 'image'
        ? html`<div class="card card-pad form-stack">
            <h2 class="section-title">Deploy webhook</h2>
            <p class="text-muted t-sm mt-0">CI posts <code class="inline">{"digest": "sha256:…"}</code> here after pushing the image; see <code class="inline">examples/github-actions/deploy.yml</code>. The URL is its own secret: anyone holding it can deploy, but only digests of <span class="mono">${p.image?.imageRef}</span>.</p>
            ${opts.webhookUrl ? shownOnce('Webhook URL', opts.webhookUrl, 'Shown once. Store it as a CI secret now; rotating makes a new one and the old one stops working.') : ''}
            <div class="row">${postButton(`${base(p)}/webhook`, p.hasWebhook ? 'Rotate webhook URL' : 'Create webhook URL', {
              cls: 'btn-secondary',
              confirm: p.hasWebhook ? 'Rotate the webhook URL? The old one stops working at once.' : undefined,
            })}<span class="text-muted t-sm">${p.hasWebhook ? 'A webhook URL is set.' : 'No webhook yet.'}</span></div>
          </div>`
        : ''}
      <form class="card card-pad danger-zone form-stack" method="post" action="${base(p)}/delete">
        <h2 class="section-title">Delete project</h2>
        <p class="text-muted t-sm mt-0">Stops the containers and removes the route, files and history. <span class="mono">data/</span> and named volumes are kept unless you tick the box.</p>
        <label class="checkbox"><input type="checkbox" name="deleteData" /> Also delete data/ and named volumes</label>
        ${field({ label: `Type ${p.name} to confirm`, name: 'confirmName', mono: true, required: true, attrs: `autocomplete="off" spellcheck="false" data-confirm-name="${p.name}"` })}
        <div class="form-actions"><button class="btn btn-danger" type="submit" data-confirm-target>${icon('trash', 14)}Delete ${p.name}</button><span class="text-muted t-sm">This cannot be undone.</span></div>
      </form>`, opts.error ? 400 : undefined);
  };

  app.get('/projects/:name/settings', (c) => settingsPage(c, projectByName(c)));

  app.post('/projects/:name/settings', async (c) => {
    const p = projectByName(c);
    const f = await readForm(c);
    try {
      const changes = p.kind === 'image'
        ? {
            hostname: f.hostname?.trim(), imageRef: f.imageRef?.trim(), containerPort: int(f.containerPort),
            registryId: int(f.registryId) ?? null, healthPath: optNull(f.healthPath), memLimit: optNull(f.memLimit),
            dataOwner: optNull(f.dataOwner),
          }
        : { hostname: f.hostname?.trim() };
      const updated = s.projects.update(ctx(c), p.id, changes);
      return view.redirect(c, `${base(updated)}/settings`, 'success', 'Saved. Deploy to apply it.');
    } catch (err) {
      return settingsPage(c, p, { form: f, error: message(err) });
    }
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
    return view.render(c, {
      title: `Deploy #${d.id}`,
      nav: 'projects',
      crumbs: [{ label: 'Projects', href: '/' }, { label: p.name, href: base(p) }, { label: `deploy #${d.id}` }],
      body: html`
        ${pageHeader(html`Deploy #${d.id} ${pill(d.status, 'deploy')}`, html`<a href="${base(p)}">${p.name}</a> · ${d.trigger} by ${d.actor} · ${ago(d.createdAt)}`, html`
          ${finished ? postButton(`${base(p)}/deploy`, 'Deploy again', { cls: 'btn-primary' }) : ''}
          <a class="btn btn-secondary" href="${base(p)}/deploys">All deploys</a>`)}
        ${d.status === 'failed' ? alert('danger', d.failureReason ?? 'unknown reason', 'Deploy failed') : ''}
        ${d.status === 'healthy' ? alert('success', html`<a href="${view.appUrl(p.hostname)}" rel="noopener noreferrer" target="_blank">${p.hostname}</a> is serving this version.`, 'Live') : ''}
        <div class="card card-pad">
          <div class="props">
            <div class="props-key">Version</div><div class="props-val mono">${p.kind === 'image' ? d.digest ? copyable(d.digest) : 'latest for the tag' : version ? `compose version ${version}` : 'unknown'}</div>
            <div class="props-key">Queued</div><div class="props-val">${ago(d.createdAt)}</div>
            <div class="props-key">Took</div><div class="props-val">${duration(d.startedAt, d.finishedAt) || (finished ? '' : 'still going')}</div>
          </div>
        </div>
        <div class="log-viewer"${finished ? '' : raw(` data-stream="/api/deploys/${d.id}/logs?after=${lastSeq}"`)}>
          <div class="log-viewer-header">
            <strong>Deploy log</strong>
            <span class="log-live" data-live hidden><span class="log-live-dot"></span> connecting</span>
          </div>
          <pre class="log-body log-tall" aria-live="polite">${lines.map((l) => html`<div class="log-line"><span class="log-num">${l.seq}</span><span class="log-ts">${l.ts.slice(11, 19)}</span><span class="${lineClass(l.stream, l.line)}">${l.line}</span></div>`)}</pre>
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

function liveVersion(p: Project, long = false): Html {
  if (p.kind === 'image') return long && p.image?.currentDigest ? copyable(p.image.currentDigest) : shortDigest(p.image?.currentDigest);
  return p.deployedComposeVersion === null ? html`<span class="text-subtle">none</span>` : html`compose v${p.deployedComposeVersion}`;
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

function deployTable(deploys: Deploy[], versions: Map<number, number>): Html {
  return html`<table class="table">
    <thead><tr><th>Deploy</th><th>Status</th><th>Trigger</th><th>Version</th><th>By</th><th>Queued</th><th>Took</th><th>Reason</th></tr></thead>
    <tbody>${deploys.length === 0
      ? emptyRow(8, html`<div class="empty-state">
          <div class="empty-title">No deploys yet</div>
          <p>Press <strong>Deploy</strong> above, or let CI post to the project's webhook.</p>
        </div>`)
      : deploys.map((d) => html`<tr>
        <td><a href="/deploys/${d.id}">#${d.id}</a></td>
        <td>${pill(d.status, 'deploy')}</td>
        <td>${d.trigger}</td>
        <td class="cell-mono">${d.composeVersionId !== null ? `v${versions.get(d.composeVersionId) ?? '?'}` : shortDigest(d.digest)}</td>
        <td>${d.actor}</td>
        <td>${ago(d.createdAt)}</td>
        <td>${duration(d.startedAt, d.finishedAt)}</td>
        <td class="cell-wrap">${d.failureReason ?? ''}</td>
      </tr>`)}</tbody>
  </table>`;
}
