import { type Context, Hono } from 'hono';
import { html } from 'hono/html';
import { parseImageRef } from '../docker/image-ref.ts';
import { AppError } from '../errors.ts';
import { type AppEnv, principal } from '../http/auth.ts';
import type { AuditActor, AuditEntry, AuditFilter } from '../services/audit.ts';
import type { Services } from '../services/index.ts';
import type { Project } from '../services/projects.ts';
import type { Registry } from '../services/registries.ts';
import type { ApiToken } from '../services/tokens.ts';
import {
  ACTIONS, ago, alert, choiceGroup, clockTime, copyable, copyButton, dataTable, dayLabel, drawer, emptyRow, emptyState, field, type FieldErrors,
  fieldErrors, type Html, linkButton, pageHeader, postButton, selectField, shortDigest, shownOnce, statusBadge, tag,
} from './components.ts';
import { type Names, names } from './names.ts';
import { readForm } from './projects.ts';
import type { View } from './view.ts';

const PAGE = 50;

const message = (err: unknown): string => {
  if (err instanceof AppError) return err.message;
  console.error(err);
  return 'Something went wrong; see the Vibeship logs.';
};

const SCOPES = [
  { value: 'read', title: 'read', desc: 'Sees projects, deploys and logs. Never secrets.' },
  { value: 'deploy', title: 'deploy', desc: 'Also creates, configures and deploys projects.' },
  { value: 'admin', title: 'admin', desc: 'Also deletes projects and manages tokens.' },
];

/** Registries, API tokens, the audit log and general settings. */
export function adminPages(deps: { services: Services; view: View }): Hono<AppEnv> {
  const { services: s, view } = deps;
  const app = new Hono<AppEnv>();
  const ctx = (c: Context<AppEnv>) => principal(c).ctx;
  const crumbs = (label: string) => [{ label }];
  const wantsDrawer = (c: Context) => c.req.query('new') !== undefined;

  // These pages used to live under /settings; keep old bookmarks working.
  for (const page of ['registries', 'tokens', 'audit']) {
    app.get(`/settings/${page}`, (c) => {
      const q = new URL(c.req.url).search;
      return c.redirect(`/${page}${q}`, 301);
    });
  }

  // Registries

  /** Projects pulling through each registry: named on the project, or matched by image host. */
  const usedBy = (list: Registry[]): Map<number, Array<{ p: Project; how: 'named' | 'host' }>> => {
    const out = new Map(list.map((r) => [r.id, [] as Array<{ p: Project; how: 'named' | 'host' }>]));
    for (const p of s.projects.list()) {
      if (!p.image) continue;
      if (p.image.registryId) {
        out.get(p.image.registryId)?.push({ p, how: 'named' });
        continue;
      }
      let host: string | null = null;
      try {
        host = parseImageRef(p.image.imageRef).host;
      } catch { /* unparseable ref: no match */ }
      const r = host ? list.find((x) => x.host === host) : undefined;
      if (r) out.get(r.id)!.push({ p, how: 'host' });
    }
    return out;
  };

  const registryFields = (v: Record<string, string>, e: FieldErrors, opts: { hasToken?: boolean; editing?: boolean }) => html`
    <div class="form-grid">
      ${field({ label: 'Name', name: 'name', value: v.name, required: true, span: 4, error: e.name, placeholder: 'repoflow' })}
      ${field({ label: 'URL', name: 'url', value: v.url, required: true, mono: true, span: 4, error: e.url, placeholder: 'https://repoflow.example.com', help: 'Its host is how image references name it.' })}
      ${field({ label: 'Username', name: 'username', value: v.username, mono: true, error: e.username, attrs: 'autocomplete="off"', help: opts.editing ? 'Clear it to pull anonymously; that also removes the token.' : 'Empty: pull anonymously.' })}
      ${field({
        label: 'Token', name: 'token', type: 'password', mono: true, error: e.token, attrs: 'autocomplete="new-password"',
        help: opts.hasToken ? 'Leave blank to keep the current token. Encrypted at rest and never shown again.' : 'Use a read-only token. Encrypted at rest and never shown again.',
      })}
    </div>`;

  const registriesPage = (c: Context<AppEnv>, adding?: { form: Record<string, string>; error?: string; errors?: FieldErrors }) => {
    const list = s.registries.list();
    const uses = usedBy(list);
    const open = Boolean(adding) || wantsDrawer(c);
    const f = adding?.form ?? {};
    return view.render(c, {
      title: 'Registries',
      nav: 'registries',
      status: adding?.error ? 400 : 200,
      crumbs: crumbs('Registries'),
      body: html`${pageHeader('Registries', 'Logins for pulling private images. A project uses the login whose host matches its image, unless it names one.',
          linkButton('/registries?new', 'Add registry', { variant: 'primary', icon: 'plus', drawer: 'new-registry' }))}
        ${dataTable({
          caption: 'Registries',
          head: ['Name', 'URL', 'Login', 'Used by', ACTIONS],
          body: html`<tbody>${list.length === 0
            ? emptyRow(5, emptyState('No registries', 'Public images need none. Add one to pull private images with a read-only token.',
                linkButton('/registries?new', 'Add registry', { variant: 'primary', size: 'sm', icon: 'plus', drawer: 'new-registry' })))
            : list.map((r) => {
              const used = uses.get(r.id) ?? [];
              return html`<tr>
                <td class="cell-name">${r.name}</td>
                <td>${copyable(r.url)}</td>
                <td>${r.username ? html`<span class="mono">${r.username}</span> <span class="text-muted">· token set</span>` : html`<span class="text-muted">Anonymous</span>`}</td>
                <td class="cell-wrap">${used.length === 0
                  ? html`<span class="text-subtle">no projects</span>`
                  : used.map(({ p, how }, i) => html`${i > 0 ? ', ' : ''}<a href="/projects/${p.name}" title="${how === 'named' ? 'Named in the project settings' : 'Matched by image host'}">${p.name}</a>`)}</td>
                <td class="cell-actions">${linkButton(`/registries/${r.id}`, 'Edit', { variant: 'secondary', size: 'sm' })}</td>
              </tr>`;
            })}</tbody>`,
        })}
        ${drawer({
          id: 'new-registry',
          title: 'Add registry',
          open,
          closeHref: '/registries',
          body: html`<form class="form-stack" method="post" action="/registries" novalidate>
            ${adding?.error ? alert('danger', adding.error, 'Not added') : ''}
            ${registryFields(f, adding?.errors ?? {}, {})}
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Add registry</button>
              <a class="btn btn-ghost" href="/registries" data-drawer-close>Cancel</a>
            </div>
          </form>`,
        })}`,
    });
  };

  app.get('/registries', (c) => registriesPage(c));
  app.post('/registries', async (c) => {
    const f = await readForm(c);
    try {
      const r = s.registries.create(ctx(c), {
        name: f.name, url: f.url, username: f.username?.trim() || null, token: f.token || null,
      });
      return view.redirect(c, '/registries', 'success', `Added ${r.name}.`);
    } catch (err) {
      return registriesPage(c, { form: { ...f, token: '' }, error: message(err), errors: fieldErrors(err) });
    }
  });

  const registryById = (c: Context<AppEnv>) => {
    const id = c.req.param('id');
    if (!id || !/^\d{1,15}$/.test(id)) throw new AppError('not_found', 'Registry not found');
    return s.registries.get(Number(id));
  };

  const editRegistryPage = (c: Context<AppEnv>, r: Registry, f?: Record<string, string>, error?: string, errors: FieldErrors = {}) => {
    const v = f ?? { name: r.name, url: r.url, username: r.username ?? '' };
    return view.render(c, {
      title: `Edit ${r.name}`,
      nav: 'registries',
      status: error ? 400 : 200,
      crumbs: [{ label: 'Registries', href: '/registries' }, { label: r.name }],
      body: html`${pageHeader(`Edit ${r.name}`, 'Changes apply to the next pull. Projects that name this registry keep using it.')}
        <form class="card card-pad form-stack form-card" method="post" action="/registries/${r.id}" novalidate>
          ${error ? alert('danger', error, 'Not saved') : ''}
          ${registryFields({ ...v, token: '' }, errors, { hasToken: r.hasToken, editing: true })}
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><a class="btn btn-ghost" href="/registries">Cancel</a></div>
        </form>`,
    });
  };

  app.get('/registries/:id', (c) => editRegistryPage(c, registryById(c)));
  app.post('/registries/:id', async (c) => {
    const r = registryById(c);
    const f = await readForm(c);
    try {
      const updated = s.registries.update(ctx(c), r.id, {
        name: f.name, url: f.url, username: f.username?.trim() || null, token: f.token || undefined,
      });
      return view.redirect(c, '/registries', 'success', `Saved ${updated.name}.`);
    } catch (err) {
      return editRegistryPage(c, r, f, message(err), fieldErrors(err));
    }
  });

  // API tokens

  const tokenState = (t: ApiToken): 'active' | 'expired' | 'revoked' =>
    t.revokedAt ? 'revoked' : t.expiresAt !== null && Date.parse(t.expiresAt) <= Date.now() ? 'expired' : 'active';

  const scopeTag = (scope: string) => tag(scope, { tone: scope === 'admin' ? 'warning' : 'neutral', title: SCOPES.find((x) => x.value === scope)?.desc });

  const tokensPage = (c: Context<AppEnv>, extra: { created?: { token: string; name: string }; error?: string; errors?: FieldErrors; form?: Record<string, string> } = {}) => {
    const tokens = s.tokens.list();
    const live = tokens.filter((t) => tokenState(t) !== 'revoked');
    const revoked = tokens.filter((t) => tokenState(t) === 'revoked');
    const f = extra.form ?? {};
    const e = extra.errors ?? {};
    const mcpUrl = `${view.publicUrl}/mcp`;
    const presets = html`<div class="presets" role="group" aria-label="Expiry presets">
      ${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'No expiry']].map(([days, label]) => html`<button class="chip" type="button" data-expiry-days="${days}" data-expiry-for="f-expiresOn" aria-pressed="false">${label}</button>`)}
    </div>`;
    return view.render(c, {
      title: 'API tokens',
      nav: 'tokens',
      status: extra.error ? 400 : 200,
      crumbs: crumbs('API tokens'),
      body: html`${pageHeader('API tokens', html`<span>For the HTTP API and MCP at</span>${copyable(mcpUrl)}`,
          linkButton('/tokens?new', 'Create token', { variant: 'primary', icon: 'plus', drawer: 'new-token' }))}
        ${extra.created ? shownOnce(`Token "${extra.created.name}"`, extra.created.token, 'Copy it now; it cannot be read back.') : ''}
        ${extra.created ? (() => {
          const cmd = `claude mcp add --transport http vibeship ${mcpUrl} --header "Authorization: Bearer ${extra.created.token}"`;
          return html`<div><div class="label">For Claude Code</div><div class="code-block"><pre>${cmd}</pre>${copyButton(cmd, 'Copy the command')}</div></div>`;
        })() : ''}
        ${dataTable({
          caption: 'API tokens',
          head: ['Name', 'Scope', 'Created', 'Last used', 'Expires', 'Status', ACTIONS],
          body: html`<tbody>${live.length === 0
            ? emptyRow(7, emptyState('No API tokens yet', html`A token lets Claude Code, another agent or CI talk to Vibeship over MCP or the HTTP API. <em>deploy</em> scope suits most agents.`,
                linkButton('/tokens?new', 'Create token', { variant: 'primary', size: 'sm', icon: 'plus', drawer: 'new-token' })))
            : live.map((t) => {
              const state = tokenState(t);
              return html`<tr id="token-${t.id}">
                <td class="cell-name">${t.name}</td>
                <td>${scopeTag(t.scope)}</td>
                <td class="cell-nowrap">${ago(t.createdAt)}</td>
                <td class="cell-nowrap">${ago(t.lastUsedAt)}</td>
                <td class="cell-nowrap">${t.expiresAt ? ago(t.expiresAt) : html`<span class="text-subtle">never</span>`}</td>
                <td>${statusBadge(state)}</td>
                <td class="cell-actions">${state === 'active' ? postButton(`/tokens/${t.id}/revoke`, 'Revoke', {
                  size: 'sm',
                  destructive: { title: `Revoke ${t.name}?`, body: 'Anything using this token stops working at once. This cannot be undone.', action: 'Revoke' },
                }) : ''}</td>
              </tr>`;
            })}</tbody>`,
        })}
        ${revoked.length > 0
          ? html`<details class="collapse" id="revoked-tokens">
              <summary>Revoked <span class="chip-count">${revoked.length}</span></summary>
              ${dataTable({
                caption: 'Revoked API tokens',
                head: ['Name', 'Scope', 'Created', 'Last used', 'Revoked', 'Status'],
                body: html`<tbody>${revoked.map((t) => html`<tr class="is-dimmed" id="token-${t.id}">
                  <td class="cell-name">${t.name}</td>
                  <td>${scopeTag(t.scope)}</td>
                  <td class="cell-nowrap">${ago(t.createdAt)}</td>
                  <td class="cell-nowrap">${ago(t.lastUsedAt)}</td>
                  <td class="cell-nowrap">${ago(t.revokedAt, { prefix: 'Revoked' })}</td>
                  <td>${statusBadge('revoked')}</td>
                </tr>`)}</tbody>`,
              })}
            </details>`
          : ''}
        ${drawer({
          id: 'new-token',
          title: 'Create token',
          open: Boolean(extra.error) || (!extra.created && wantsDrawer(c)),
          closeHref: '/tokens',
          body: html`<form class="form-stack" method="post" action="/tokens" novalidate>
            ${extra.error ? alert('danger', extra.error, 'Not created') : ''}
            <div class="form-grid">
              ${field({ label: 'Name', name: 'name', value: f.name, required: true, span: 4, error: e.name, placeholder: 'claude-code laptop', help: 'Unique among active tokens; shows in the audit log.' })}
              ${choiceGroup({ legend: 'Scope', name: 'scope', value: f.scope ?? 'deploy', options: SCOPES, span: 4, mono: true })}
              ${field({ label: 'Expires on', name: 'expiresOn', value: f.expiresOn, type: 'date', mono: true, span: 4, error: e.expiresOn ?? e.expiresAt, after: presets, help: 'Optional; at 00:00 UTC that day.' })}
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Create token</button>
              <a class="btn btn-ghost" href="/tokens" data-drawer-close>Cancel</a>
            </div>
          </form>`,
        })}`,
    });
  };

  app.get('/tokens', (c) => tokensPage(c));
  app.post('/tokens', async (c) => {
    const f = await readForm(c);
    try {
      const expiresOn = f.expiresOn?.trim();
      if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
        throw new AppError('validation', 'expiresOn: use YYYY-MM-DD', { issues: [{ path: 'expiresOn', message: 'use YYYY-MM-DD' }] });
      }
      const { token, apiToken } = s.tokens.create(ctx(c), {
        name: f.name, scope: f.scope, expiresAt: expiresOn ? `${expiresOn}T00:00:00Z` : null,
      });
      return tokensPage(c, { created: { token, name: apiToken.name } });
    } catch (err) {
      return tokensPage(c, { error: message(err), errors: fieldErrors(err), form: f });
    }
  });
  app.post('/tokens/:id/revoke', (c) => {
    const id = Number(c.req.param('id'));
    try {
      if (!Number.isInteger(id) || id < 1) throw new AppError('not_found', 'Token not found');
      const t = s.tokens.revoke(ctx(c), id);
      return view.redirect(c, '/tokens', 'success', `Revoked ${t.name}.`);
    } catch (err) {
      return view.redirect(c, '/tokens', 'danger', message(err));
    }
  });

  // Audit log

  app.get('/audit', (c) => {
    const q = c.req.query();
    const before = Number(q.before ?? '') || undefined;
    const n = names(s);
    const facets = s.audit.facets();
    const filter = auditFilter(q);
    const entries = s.audit.list({ ...filter, limit: PAGE, beforeId: before });
    // The filters, kept when paging.
    const params = new URLSearchParams(Object.entries(q).filter(([k, v]) => k !== 'before' && v !== ''));
    const withBefore = (id?: number) => {
      const p = new URLSearchParams(params);
      if (id) p.set('before', String(id));
      const str = p.toString();
      return `/audit${str ? `?${str}` : ''}`;
    };
    const filtered = params.size > 0;
    const actorLabel = (a: AuditActor) => a.type === 'user' ? n.userEmail(a.id) ?? `user:${a.id}` : a.type === 'token' ? `${n.tokenName(a.id) ?? `token:${a.id}`} (token)` : 'System';
    const actorValue = (a: AuditActor) => a.type === 'system' ? 'system' : `${a.type}:${a.id}`;

    // Rows under a header per day (UTC, like every time shown).
    const rows: Html[] = [];
    let day = '';
    for (const e of entries) {
      const label = dayLabel(e.ts);
      if (label !== day) {
        day = label;
        rows.push(html`<tr class="group-row"><th colspan="5" scope="colgroup">${label}</th></tr>`);
      }
      rows.push(html`<tr>
        <td class="cell-nowrap">${clockTime(e.ts)}</td>
        <td class="cell-nowrap">${auditActor(e, n)}</td>
        <td>${tag(e.action, { tone: DESTRUCTIVE.test(e.action) ? 'danger' : 'neutral' })}</td>
        <td class="cell-wrap">${auditSentence(e, n)}${rawDetails(e)}</td>
        <td class="cell-mono cell-nowrap">${e.ip ?? ''}</td>
      </tr>`);
    }

    return view.render(c, {
      title: 'Audit log',
      nav: 'audit',
      crumbs: crumbs('Audit log'),
      body: html`${pageHeader('Audit log', 'Every change, by whom and from where. Secret values are never recorded. Times are UTC.')}
        <form class="panel filters" method="get" action="/audit" data-autosubmit aria-label="Filter the audit log">
          ${selectField({ label: 'Action', name: 'action', value: q.action, options: [{ value: '', label: 'All actions' }, ...facets.actions.map((a) => ({ value: a, label: a }))] })}
          ${selectField({ label: 'Actor', name: 'actor', value: q.actor, options: [{ value: '', label: 'Anyone' }, ...facets.actors.map((a) => ({ value: actorValue(a), label: actorLabel(a) }))] })}
          ${selectField({ label: 'Target', name: 'target', value: q.target, options: [{ value: '', label: 'Any target' }, ...facets.targetTypes.map((t) => ({ value: t, label: t }))] })}
          <div class="field field-date"><label class="field-label" for="f-from">From</label><input class="input input-mono" id="f-from" name="from" type="date" value="${q.from ?? ''}" /></div>
          <div class="field field-date"><label class="field-label" for="f-to">To</label><input class="input input-mono" id="f-to" name="to" type="date" value="${q.to ?? ''}" /></div>
          <label class="checkbox"><input type="checkbox" name="hideAuth" value="1"${q.hideAuth === '1' ? html` checked` : ''} /> Hide sign-in events</label>
          <div class="form-actions">
            <button class="btn btn-secondary" type="submit">Apply</button>
            ${filtered ? html`<a class="btn btn-ghost" href="/audit">Reset</a>` : ''}
          </div>
        </form>
        ${dataTable({
          caption: 'Audit log',
          compact: true,
          head: ['Time', 'Actor', 'Action', 'Details', 'IP'],
          body: html`<tbody>${entries.length === 0
            ? emptyRow(5, filtered
                ? emptyState('Nothing matches', html`Try fewer filters, or <a href="/audit">reset them</a>.`)
                : emptyState('Nothing recorded yet', 'Creating projects, deploying, changing env vars or tokens all show up here.'))
            : rows}</tbody>`,
        })}
        <nav class="pagination" aria-label="Audit log pages">
          <span class="text-muted t-sm">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${before ? ' on this page' : ''}</span>
          <div class="pagination-links">
            ${before ? html`<a class="btn btn-secondary btn-sm" href="${withBefore()}">Newest</a>` : ''}
            ${entries.length === PAGE ? html`<a class="btn btn-secondary btn-sm" href="${withBefore(entries.at(-1)!.id)}">Older</a>` : ''}
          </div>
        </nav>`,
    });
  });

  // General settings

  const settingsPage = (c: Context<AppEnv>, error?: string, value?: string) => view.render(c, {
    title: 'Settings',
    nav: 'settings',
    status: error ? 400 : 200,
    crumbs: [{ label: 'Settings' }],
    body: html`${pageHeader('Settings', 'Defaults for every project.')}
      <form class="card card-pad form-stack form-card" method="post" action="/settings" novalidate>
        <h2 class="card-title">Deploys</h2>
        ${error ? alert('danger', error, 'Not saved') : ''}
        <div class="form-grid">
          ${field({
            label: 'Health check timeout (seconds)', name: 'health_timeout_seconds', type: 'number', required: true,
            value: value ?? s.settings.get('health_timeout_seconds'), attrs: 'min="1"',
            help: 'How long a new version has to become healthy before the deploy fails and the last healthy version comes back.',
          })}
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>`,
  });

  app.get('/settings', (c) => settingsPage(c));
  app.post('/settings', async (c) => {
    const f = await readForm(c);
    try {
      const raw = f.health_timeout_seconds?.trim() ?? '';
      s.settings.set(ctx(c), 'health_timeout_seconds', raw === '' ? undefined : Number(raw));
      return view.redirect(c, '/settings', 'success', 'Settings saved.');
    } catch (err) {
      return settingsPage(c, message(err), f.health_timeout_seconds);
    }
  });

  return app;
}

// ——— Audit log helpers ———

/** Actions that remove or switch something off; shown in the danger tone. */
const DESTRUCTIVE = /\.(delete|revoke|stop)$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The query string's filters, ignoring anything malformed. */
function auditFilter(q: Record<string, string>): AuditFilter {
  const f: AuditFilter = {};
  if (q.action) f.action = q.action;
  const actor = /^(user|token):(\d+)$/.exec(q.actor ?? '');
  if (actor) f.actor = { type: actor[1] as 'user' | 'token', id: Number(actor[2]) };
  else if (q.actor === 'system') f.actor = { type: 'system' };
  if (q.target && /^[a-z_]+$/.test(q.target)) f.targetType = q.target;
  if (q.from && DATE.test(q.from)) f.since = `${q.from}T00:00:00.000Z`;
  if (q.to && DATE.test(q.to)) {
    const next = new Date(`${q.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    f.until = next.toISOString();
  }
  if (q.hideAuth === '1') f.excludeActionPrefixes = ['auth.'];
  return f;
}

/** The email, the token name, or "System (webhook)". */
function auditActor(e: AuditEntry, n: Names): Html {
  if (e.actorType === 'user' && e.userId !== null) return n.actor(`user:${e.userId}`);
  if (e.actorType === 'token' && e.tokenId !== null) return n.actor(`token:${e.tokenId}`);
  return n.actor('system', { trigger: typeof e.details.trigger === 'string' ? e.details.trigger : undefined });
}

/** Formatted JSON behind a "Raw" toggle; long values wrap inside it. */
function rawDetails(e: AuditEntry): Html {
  if (!e.target && Object.keys(e.details).length === 0) return html``;
  return html`<details class="raw"><summary>Raw</summary><pre>${JSON.stringify({ target: e.target, ...e.details }, null, 2)}</pre></details>`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
const mono = (v: unknown): Html => html`<span class="mono">${str(v)}</span>`;
const list = (v: unknown): Html => {
  const items = Array.isArray(v) ? v.map(str) : [];
  return items.length === 0 ? html`nothing` : html`${items.map((x, i) => html`${i > 0 ? ', ' : ''}<code class="inline">${x}</code>`)}`;
};
const COLUMN_NAMES: Record<string, string> = {
  hostname: 'hostname', image_ref: 'image', container_port: 'port', registry_id: 'registry', health_path: 'health path', mem_limit: 'memory limit', data_owner: 'data owner',
};

/** One readable sentence per action, e.g. "Deleted project **hello** (hello.example.com)". */
function auditSentence(e: AuditEntry, n: Names): Html {
  const d = e.details;
  const target = n.target(e.target, str(d.name ?? d.project) || undefined);
  const project = (name: unknown) => n.projectLink(str(name));
  switch (e.action) {
    case 'project.create': return html`Created ${str(d.kind)} project ${target} at ${mono(d.hostname)}`;
    case 'project.update': {
      const keys = Object.keys((d.changes ?? {}) as object).map((k) => COLUMN_NAMES[k] ?? k);
      return html`Changed the ${keys.join(', ') || 'settings'} of ${target}`;
    }
    case 'project.delete': return html`Deleted project ${target} (${mono(d.hostname)})`;
    case 'project.stop': return html`Stopped ${target}`;
    case 'project.start': return html`Started ${target}`;
    case 'project.restart': return html`Restarted ${target}`;
    case 'compose.version': return html`Saved compose version ${str(d.version)} of ${target}${d.note ? html`: “${str(d.note)}”` : ''}`;
    case 'webhook.create': return html`Created the deploy webhook of ${target}`;
    case 'webhook.rotate': return html`Rotated the deploy webhook of ${target}`;
    case 'deploy.request': {
      const version = d.digest && d.digest !== 'latest' ? html` at ${shortDigest(str(d.digest), { copy: false })}`
        : d.composeVersion ? html` of compose version ${str(d.composeVersion)}` : html` of the latest image`;
      return html`Deployed ${project(d.project)}${version} (deploy ${target})`;
    }
    case 'deploy.interrupted': return html`Deploy ${target} of ${project(d.project)} was cut off by a restart`;
    case 'deploy.recovery': return html`Brought ${project(d.project)} back after a restart (deploy ${n.target(`deploy:${str(d.deploy)}`)})`;
    case 'deploy.recovery_not_needed': return html`${project(d.project)} was still running after a restart`;
    case 'deploy.recovery_stopped': return html`${project(d.project)} stayed stopped after a restart`;
    case 'env.set': {
      const unset = Array.isArray(d.unset) && d.unset.length > 0;
      const set = Array.isArray(d.set) && d.set.length > 0;
      return html`${set ? html`Set ${list(d.set)}` : ''}${set && unset ? ' and ' : ''}${unset ? html`${set ? 'removed' : 'Removed'} ${list(d.unset)}` : ''} on ${target}`;
    }
    case 'env.replace': return html`Replaced the env vars of ${target}: set ${list(d.set)}, kept ${list(d.kept)}`;
    case 'registry.create': return html`Added registry ${target} (${mono(d.host)})`;
    case 'registry.update': return html`Updated registry ${target}${d.tokenChanged ? ' and its token' : ''}`;
    case 'token.create': return html`Created ${str(d.scope)} token ${target}${d.expiresAt ? html`, expiring ${ago(str(d.expiresAt))}` : ''}`;
    case 'token.revoke': return html`Revoked token ${target}`;
    case 'settings.set': return html`Set ${target} to ${mono(d.value)}`;
    case 'auth.login': return html`Signed in`;
    case 'auth.logout': return html`Signed out`;
    case 'auth.refused': return html`Refused a sign-in by ${mono(d.email)}${d.emailVerified === false ? ' (email not verified)' : ''}`;
    default: return html`${e.action} ${target}`;
  }
}
