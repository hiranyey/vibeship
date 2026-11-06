import { type Context, Hono } from 'hono';
import { html, raw } from 'hono/html';
import { parseImageRef } from '../docker/image-ref.ts';
import { AppError } from '../errors.ts';
import { type AppEnv, principal } from '../http/auth.ts';
import type { AuditActor, AuditEntry, AuditFilter } from '../services/audit.ts';
import type { Services } from '../services/index.ts';
import type { Project } from '../services/projects.ts';
import type { Registry } from '../services/registries.ts';
import type { ApiToken } from '../services/tokens.ts';
import {
  ACTIONS, ago, alert, choiceGroup, copyable, copyButton, dataTable, dayLabel, drawer, emptyRow, emptyState, field, type FieldErrors,
  fieldErrors, type Html, linkButton, pageHeader, postButton, presetGroup, selectField, shortDigest, shownOnce, statusBadge, tag,
} from './components.ts';
import { icon } from './icons.ts';
import { type Names, names } from './names.ts';
import { readForm } from './projects.ts';
import { initials, type View } from './view.ts';

const PAGE = 50;

const message = (err: unknown): string => {
  if (err instanceof AppError) return err.message;
  console.error(err);
  return 'Something went wrong; see the Vibeship logs.';
};

const SCOPES = [
  { value: 'read', title: 'read', desc: 'Sees everything except secrets.' },
  { value: 'deploy', title: 'deploy', desc: 'Also creates, configures and deploys projects.' },
  { value: 'admin', title: 'admin', desc: 'Also deletes projects and manages tokens.' },
];

const EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom date' },
  { value: 'none', label: 'Never' },
];

/** "6 Dec 2026", in UTC like every date shown. */
const shortDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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

  const registryFields = (v: Record<string, string>, e: FieldErrors, opts: { hasToken?: boolean; editing?: boolean; wide?: boolean }) => html`
    <div class="form-grid">
      ${field({ label: 'Name', name: 'name', value: v.name, required: true, mono: false, span: opts.wide ? 4 : 12, error: e.name, placeholder: 'e.g. Repoflow' })}
      ${field({ label: 'URL', name: 'url', value: v.url, required: true, span: opts.wide ? 8 : 12, error: e.url, placeholder: 'e.g. https://api.repoflow.io', help: 'Its host is how image references name it.' })}
      ${field({ label: 'Username', name: 'username', value: v.username, span: opts.wide ? 4 : 12, error: e.username, attrs: 'autocomplete="off"', help: opts.editing ? 'Clear it to pull anonymously; that also removes the token.' : 'Empty: pull anonymously.' })}
      ${field({
        label: 'Token', name: 'token', type: 'password', span: opts.wide ? 8 : 12, error: e.token, attrs: 'autocomplete="new-password"',
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
                <td>${r.username ? html`<span class="mono t-sm">${r.username}</span> <span class="text-muted">· token set</span>` : html`<span class="text-muted">Anonymous</span>`}</td>
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
          body: html`<form method="post" action="/registries" novalidate>
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
        <form class="card" method="post" action="/registries/${r.id}" novalidate>
          <div class="card-body">
            ${error ? alert('danger', error, 'Not saved') : ''}
            ${registryFields({ ...v, token: '' }, errors, { hasToken: r.hasToken, editing: true, wide: true })}
          </div>
          <div class="card-footer"><button class="btn btn-primary" type="submit">Save</button><a class="btn btn-ghost" href="/registries">Cancel</a></div>
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

  /** The hint under the expiry presets; ui.js keeps it current as the choice changes. */
  const expiryHint = (pick: string, date?: string): { text: string; warn: boolean } => {
    if (pick === 'none') return { text: 'This token never expires. Prefer an expiry for tokens used by automation.', warn: true };
    if (pick === 'custom') return { text: date ? `Expires ${shortDate(new Date(`${date}T00:00:00Z`))} at 00:00 UTC.` : 'Expires at 00:00 UTC on the date you pick.', warn: false };
    return { text: `Expires ${shortDate(new Date(Date.now() + Number(pick) * 86_400_000))} at 00:00 UTC.`, warn: false };
  };

  const tokensPage = (c: Context<AppEnv>, extra: { created?: { token: string; name: string }; error?: string; errors?: FieldErrors; form?: Record<string, string> } = {}) => {
    const tokens = s.tokens.list();
    const active = tokens.filter((t) => tokenState(t) === 'active');
    const ended = tokens.filter((t) => tokenState(t) !== 'active');
    const f = extra.form ?? {};
    const e = extra.errors ?? {};
    const mcpUrl = `${view.publicUrl}/mcp`;
    const pick = f.expiry ?? (f.expiresOn ? 'custom' : '30');
    const hint = expiryHint(pick, f.expiresOn);
    return view.render(c, {
      title: 'API tokens',
      nav: 'tokens',
      status: extra.error ? 400 : 200,
      crumbs: crumbs('API tokens'),
      body: html`${pageHeader('API tokens',
          html`<span>For the HTTP API and the MCP server.</span><span class="break"></span><span class="endpoint"><span class="label">MCP endpoint</span><span class="mono">${mcpUrl}</span>${copyButton(mcpUrl, 'Copy MCP endpoint')}</span>`,
          linkButton('/tokens?new', 'New token', { variant: 'primary', icon: 'plus', drawer: 'new-token' }))}
        ${extra.created ? shownOnce(`Token "${extra.created.name}"`, extra.created.token, 'Copy it now; it cannot be read back.') : ''}
        ${extra.created ? (() => {
          const cmd = `claude mcp add --transport http vibeship ${mcpUrl} --header "Authorization: Bearer ${extra.created.token}"`;
          return html`<div><div class="code-head"><span class="label">For Claude Code</span>${copyButton(cmd, 'Copy the command')}</div><pre class="code">${cmd}</pre></div>`;
        })() : ''}
        <section class="stack" aria-labelledby="active-title">
          <h2 class="section-title" id="active-title">Active <span class="count">${active.length}</span></h2>
          ${dataTable({
            caption: 'Active API tokens',
            head: ['Name', 'Scope', 'Created', 'Last used', 'Expires', 'Status', ACTIONS],
            body: html`<tbody>${active.length === 0
              ? emptyRow(7, emptyState('No active tokens', html`A token lets Claude Code, another agent or CI talk to Vibeship over MCP or the HTTP API. <em>deploy</em> scope suits most agents.`,
                  linkButton('/tokens?new', 'New token', { variant: 'primary', size: 'sm', icon: 'plus', drawer: 'new-token' })))
              : active.map((t) => html`<tr id="token-${t.id}">
                <td class="cell-name">${t.name}</td>
                <td>${scopeTag(t.scope)}</td>
                <td class="cell-nowrap cell-quiet">${ago(t.createdAt)}</td>
                <td class="cell-nowrap cell-quiet">${ago(t.lastUsedAt)}</td>
                <td class="cell-nowrap cell-quiet">${t.expiresAt ? ago(t.expiresAt) : html`<span class="text-subtle">never</span>`}</td>
                <td>${statusBadge('active')}</td>
                <td class="cell-actions">${postButton(`/tokens/${t.id}/revoke`, 'Revoke…', {
                  variant: 'ghost-danger', size: 'sm',
                  destructive: { title: `Revoke ${t.name}?`, body: 'Anything using this token stops working at once. This cannot be undone.', action: 'Revoke' },
                })}</td>
              </tr>`)}</tbody>`,
          })}
        </section>
        ${ended.length > 0
          ? html`<details class="collapse" id="revoked-tokens">
              <summary>${icon('chevron', 16)}<span>Revoked and expired</span><span class="count">${ended.length}</span></summary>
              ${dataTable({
                caption: 'Revoked and expired API tokens',
                quiet: true,
                head: ['Name', 'Scope', 'Created', 'Last used', 'Ended', 'Status'],
                body: html`<tbody>${ended.map((t) => {
                  const state = tokenState(t);
                  return html`<tr class="is-dimmed" id="token-${t.id}">
                    <td class="cell-name">${t.name}</td>
                    <td>${tag(t.scope)}</td>
                    <td class="cell-nowrap">${ago(t.createdAt)}</td>
                    <td class="cell-nowrap">${ago(t.lastUsedAt)}</td>
                    <td class="cell-nowrap">${state === 'revoked' ? ago(t.revokedAt, { prefix: 'Revoked' }) : ago(t.expiresAt, { prefix: 'Expired' })}</td>
                    <td>${statusBadge(state)}</td>
                  </tr>`;
                })}</tbody>`,
              })}
            </details>`
          : ''}
        ${drawer({
          id: 'new-token',
          title: 'New token',
          open: Boolean(extra.error) || (!extra.created && wantsDrawer(c)),
          closeHref: '/tokens',
          body: html`<form method="post" action="/tokens" novalidate>
            ${extra.error ? alert('danger', extra.error, 'Not created') : ''}
            <div class="form-grid">
              ${field({ label: 'Name', name: 'name', value: f.name, required: true, span: 12, error: e.name, placeholder: 'e.g. claude-code laptop', help: 'Must be unique. Shown in deploy history and the audit log.' })}
              ${choiceGroup({ legend: 'Scope', name: 'scope', value: f.scope ?? 'deploy', options: SCOPES, span: 12 })}
              <div class="span-12" data-expiry>
                ${presetGroup({
                  legend: 'Expires', name: 'expiry', value: pick, options: EXPIRY, span: 12,
                  after: html`<div data-expiry-custom${pick === 'custom' ? '' : raw(' hidden')}>
                      ${field({ label: 'Expiry date', name: 'expiresOn', value: f.expiresOn, type: 'date', span: 12, error: e.expiresOn ?? e.expiresAt, narrow: true })}
                    </div>
                    <p class="field-help${hint.warn ? ' field-hint-warning' : ''}" data-expiry-hint>${hint.text}</p>`,
                })}
              </div>
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
      // A preset sets the date; "custom" (or no preset, as from a script) takes the date field.
      let expiresOn = f.expiresOn?.trim();
      if (f.expiry === 'none') expiresOn = '';
      else if (/^\d{1,4}$/.test(f.expiry ?? '')) expiresOn = new Date(Date.now() + Number(f.expiry) * 86_400_000).toISOString().slice(0, 10);
      else if (f.expiry === 'custom' && !expiresOn) {
        throw new AppError('validation', 'expiresOn: pick a date, or choose another option', { issues: [{ path: 'expiresOn', message: 'Pick a date, or choose another option.' }] });
      }
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
    const range = q.range && q.range in RANGES ? q.range : q.range === 'custom' ? 'custom' : '7d';
    const filter = auditFilter(q, range);
    const entries = s.audit.list({ ...filter, limit: PAGE, beforeId: before });
    const total = s.audit.count(filter);
    // The filters, kept when paging.
    const params = new URLSearchParams(Object.entries(q).filter(([k, v]) => k !== 'before' && v !== ''));
    const withBefore = (id?: number) => {
      const p = new URLSearchParams(params);
      if (id) p.set('before', String(id));
      const str = p.toString();
      return `/audit${str ? `?${str}` : ''}`;
    };
    const filtered = [...params.keys()].some((k) => k !== 'range') || range !== '7d';
    const actorLabel = (a: AuditActor) => a.type === 'user' ? n.userEmail(a.id) ?? `user:${a.id}` : a.type === 'token' ? `${n.tokenName(a.id) ?? `token:${a.id}`} (token)` : 'System';
    const actorValue = (a: AuditActor) => a.type === 'system' ? 'system' : `${a.type}:${a.id}`;

    // Rows under a header per day (UTC, like every time shown), each with its count.
    const groups: Array<{ label: string; rows: AuditEntry[] }> = [];
    for (const e of entries) {
      const label = dayLabel(e.ts);
      if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
      groups.at(-1)!.rows.push(e);
    }
    const rows = groups.flatMap((g) => [
      html`<tr class="group-row"><th colspan="5" scope="colgroup">${g.label}<span class="group-count">${g.rows.length} event${g.rows.length === 1 ? '' : 's'}</span></th></tr>`,
      ...g.rows.map((e) => auditRow(e, n)),
    ]);

    return view.render(c, {
      title: 'Audit log',
      nav: 'audit',
      crumbs: crumbs('Audit log'),
      body: html`${pageHeader('Audit log', 'Every change, by whom and from where. Secret values are never recorded.')}
        <form class="filters" method="get" action="/audit" data-autosubmit aria-label="Filter the audit log">
          <div class="search">${icon('search', 18)}<label class="sr-only" for="f-q">Search events</label><input class="input input-ui" id="f-q" name="q" type="search" value="${q.q ?? ''}" placeholder="Search events" /></div>
          <label class="sr-only" for="f-category">Action</label>
          <select class="select" id="f-category" name="category">
            ${[['', 'All actions'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])].map(([v, l]) => html`<option value="${v}"${(q.category ?? '') === v ? raw(' selected') : ''}>${l}</option>`)}
          </select>
          <label class="sr-only" for="f-actor">Actor</label>
          <select class="select" id="f-actor" name="actor">
            <option value="">Everyone</option>
            ${facets.actors.map((a) => html`<option value="${actorValue(a)}"${q.actor === actorValue(a) ? raw(' selected') : ''}>${actorLabel(a)}</option>`)}
          </select>
          <label class="sr-only" for="f-range">Date range</label>
          <select class="select" id="f-range" name="range" data-range>
            ${Object.entries(RANGES).map(([v, r]) => html`<option value="${v}"${range === v ? raw(' selected') : ''}>${r.label}</option>`)}
            <option value="custom"${range === 'custom' ? raw(' selected') : ''}>Custom…</option>
          </select>
          <span class="date-range" data-range-custom${range === 'custom' ? '' : raw(' hidden')}>
            <label class="sr-only" for="f-from">From</label><input class="input" id="f-from" name="from" type="date" value="${q.from ?? ''}" />
            <span aria-hidden="true">–</span>
            <label class="sr-only" for="f-to">To</label><input class="input" id="f-to" name="to" type="date" value="${q.to ?? ''}" />
          </span>
          <label class="switch"><input type="checkbox" role="switch" name="hideAuth" value="1"${q.hideAuth === '1' ? raw(' checked') : ''} />Hide sign-in events</label>
          <noscript><button class="btn btn-secondary btn-sm" type="submit">Apply</button></noscript>
          ${filtered ? html`<a class="btn btn-ghost btn-sm" href="/audit">Reset</a>` : ''}
        </form>
        ${dataTable({
          caption: 'Audit log',
          tableClass: 'audit-table',
          cols: ['c-when', 'c-actor', 'c-event', 'c-ip', 'c-more'],
          head: ['When', 'Actor', 'Event', 'Client IP', { label: 'Details', srOnly: true, cls: 'cell-actions' }],
          body: html`<tbody>${entries.length === 0
            ? emptyRow(5, filtered
                ? emptyState('Nothing matches', html`Try a longer date range or fewer filters, or <a href="/audit">reset them</a>.`)
                : emptyState('Nothing in the last 7 days', 'Creating projects, deploying, changing env vars or tokens all show up here.'))
            : rows}</tbody>`,
        })}
        <nav class="pagination" aria-label="Audit log pages">
          <span class="pagination-summary">Showing ${entries.length} of ${total} event${total === 1 ? '' : 's'}</span>
          <div class="pagination-links">
            ${before ? html`<a class="btn btn-secondary" href="${withBefore()}">Newer</a>` : html`<button class="btn btn-secondary" type="button" disabled>Newer</button>`}
            ${entries.length === PAGE ? html`<a class="btn btn-secondary" href="${withBefore(entries.at(-1)!.id)}">Older</a>` : html`<button class="btn btn-secondary" type="button" disabled>Older</button>`}
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
      <form class="card" method="post" action="/settings" novalidate>
        <div class="card-head"><h2 class="card-title">Deploys</h2></div>
        <div class="card-body">
          ${error ? alert('danger', error, 'Not saved') : ''}
          <div class="form-grid">
            ${field({
              label: 'Health check timeout (seconds)', name: 'health_timeout_seconds', type: 'number', required: true, span: 4,
              value: value ?? s.settings.get('health_timeout_seconds'), attrs: 'min="1" inputmode="numeric"',
              help: 'How long a new version has to become healthy before the deploy fails and the last healthy version comes back.',
            })}
          </div>
        </div>
        <div class="card-footer"><button class="btn btn-primary" type="submit">Save</button></div>
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

/** The Action filter's categories, by action prefix. */
const CATEGORIES: Record<string, { label: string; prefixes: string[] }> = {
  projects: { label: 'Projects', prefixes: ['project.', 'compose.', 'env.', 'webhook.'] },
  deploys: { label: 'Deploys', prefixes: ['deploy.'] },
  tokens: { label: 'Tokens', prefixes: ['token.'] },
  registries: { label: 'Registries and settings', prefixes: ['registry.', 'settings.'] },
  signins: { label: 'Sign-ins', prefixes: ['auth.'] },
};

/** The Date range filter; the first is the default. */
const RANGES: Record<string, { label: string; days: number }> = {
  '7d': { label: 'Last 7 days', days: 7 },
  '24h': { label: 'Last 24 hours', days: 1 },
  '30d': { label: 'Last 30 days', days: 30 },
  'all': { label: 'All time', days: 0 },
};

/** Actions that remove or switch something off; shown in the danger tone. */
const DESTRUCTIVE = /\.(delete|revoke|stop)$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The query string's filters, ignoring anything malformed. */
function auditFilter(q: Record<string, string>, range: string): AuditFilter {
  const f: AuditFilter = {};
  if (q.action) f.action = q.action;
  const cat = q.category ? CATEGORIES[q.category] : undefined;
  if (cat) f.actionPrefixes = cat.prefixes;
  if (q.q?.trim()) f.search = q.q.trim().slice(0, 200);
  const actor = /^(user|token):(\d+)$/.exec(q.actor ?? '');
  if (actor) f.actor = { type: actor[1] as 'user' | 'token', id: Number(actor[2]) };
  else if (q.actor === 'system') f.actor = { type: 'system' };
  if (range === 'custom') {
    if (q.from && DATE.test(q.from)) f.since = `${q.from}T00:00:00.000Z`;
    if (q.to && DATE.test(q.to)) {
      const next = new Date(`${q.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      f.until = next.toISOString();
    }
  } else if (RANGES[range]!.days > 0) {
    f.since = new Date(Date.now() - RANGES[range]!.days * 86_400_000).toISOString();
  }
  if (q.hideAuth === '1') f.excludeActionPrefixes = ['auth.'];
  return f;
}

/** One entry: when, who, what (a line and a detail line), from where, and its raw JSON behind "Details". */
function auditRow(e: AuditEntry, n: Names): Html {
  const destructive = DESTRUCTIVE.test(e.action);
  const tone = destructive ? 'danger' : e.action.startsWith('deploy.') ? 'info' : 'neutral';
  const ev = auditEvent(e, n);
  const raw = e.target || Object.keys(e.details).length > 0 ? JSON.stringify({ target: e.target, ...e.details }, null, 2) : '';
  return html`<tr${destructive ? html` class="is-destructive"` : ''}>
      <td class="cell-nowrap cell-quiet">${ago(e.ts)}</td>
      <td>${auditActor(e, n)}</td>
      <td>
        <div class="event">
          <div class="event-line"><span class="event-text${e.action.startsWith('auth.') ? ' is-quiet' : ''}">${ev.text}</span>${tag(e.action, { tone })}</div>
          ${ev.sub ? html`<div class="event-sub">${ev.sub}</div>` : ''}
        </div>
      </td>
      <td class="cell-mono cell-nowrap cell-quiet">${e.ip ?? ''}</td>
      <td class="cell-actions">${raw ? html`<button class="btn-quiet" type="button" data-toggle-row="raw-${e.id}" aria-controls="raw-${e.id}" aria-expanded="false">Details</button>` : ''}</td>
    </tr>
    ${raw ? html`<tr class="raw-row${destructive ? ' is-destructive' : ''}" id="raw-${e.id}" hidden><td colspan="5"><pre class="code">${raw}</pre></td></tr>` : ''}`;
}

/** The email (mono), the token's name, or "System" with a webhook tag; each with an avatar letter. */
function auditActor(e: AuditEntry, n: Names): Html {
  if (e.actorType === 'user' && e.userId !== null) {
    const email = n.userEmail(e.userId);
    return html`<span class="actor" title="user:${e.userId}"><span class="avatar avatar-sm" aria-hidden="true">${initials(email ?? '?')}</span><span class="actor-name mono">${email ?? 'a deleted user'}</span></span>`;
  }
  if (e.actorType === 'token' && e.tokenId !== null) {
    const name = n.tokenName(e.tokenId);
    return html`<span class="actor"><span class="avatar avatar-sm avatar-system" aria-hidden="true">${initials(name ?? 'T')}</span>${
      name ? html`<a class="actor-name" href="/tokens#token-${e.tokenId}" title="token:${e.tokenId}">${name}</a>` : html`<span class="actor-name">a deleted token</span>`
    }${tag('token')}</span>`;
  }
  const webhook = e.details.trigger === 'webhook';
  return html`<span class="actor"><span class="avatar avatar-sm avatar-system" aria-hidden="true">S</span><span class="actor-name">System</span>${webhook ? tag('webhook') : ''}</span>`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
const list = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? v.map(str).join(', ') : '');
const COLUMN_NAMES: Record<string, string> = {
  hostname: 'hostname', image_ref: 'image', container_port: 'port', registry_id: 'registry', health_path: 'health path', mem_limit: 'memory limit', data_owner: 'data owner',
};

/**
 * One line saying what happened, e.g. "Deleted project deploy-or-die", and
 * an optional detail line in mono, e.g. its hostname or a digest.
 */
function auditEvent(e: AuditEntry, n: Names): { text: Html; sub?: Html | string } {
  const d = e.details;
  const target = n.target(e.target, str(d.name ?? d.project) || undefined);
  const project = (name: unknown) => n.projectLink(str(name));
  switch (e.action) {
    case 'project.create': return { text: html`Created ${str(d.kind)} project ${target}`, sub: str(d.hostname) };
    case 'project.update': {
      const keys = Object.keys((d.changes ?? {}) as object).map((k) => COLUMN_NAMES[k] ?? k);
      return { text: html`Changed the settings of ${target}`, sub: keys.join(', ') };
    }
    case 'project.delete': return { text: html`Deleted project ${target}`, sub: str(d.hostname) };
    case 'project.stop': return { text: html`Stopped ${target}` };
    case 'project.start': return { text: html`Started ${target}` };
    case 'project.restart': return { text: html`Restarted ${target}` };
    case 'compose.version': return { text: html`Saved compose version ${str(d.version)} of ${target}`, sub: d.note ? `“${str(d.note)}”` : undefined };
    case 'webhook.create': return { text: html`Created the deploy webhook of ${target}` };
    case 'webhook.rotate': return { text: html`Rotated the deploy webhook of ${target}` };
    case 'deploy.request': {
      const who = d.trigger === 'webhook' ? 'Webhook requested' : 'Requested';
      const sub = d.digest && d.digest !== 'latest' ? shortDigest(str(d.digest), { copy: false }) : d.composeVersion ? `compose version ${str(d.composeVersion)}` : 'the latest image';
      return { text: html`${who} deploy ${target} of ${project(d.project)}`, sub };
    }
    case 'deploy.interrupted': return { text: html`Deploy ${target} of ${project(d.project)} was cut off by a restart` };
    case 'deploy.recovery': return { text: html`Brought ${project(d.project)} back after a restart`, sub: html`deploy ${n.target(`deploy:${str(d.deploy)}`)}` };
    case 'deploy.recovery_not_needed': return { text: html`${project(d.project)} was still running after a restart` };
    case 'deploy.recovery_stopped': return { text: html`${project(d.project)} stayed stopped after a restart` };
    case 'env.set': {
      const set = list(d.set);
      const unset = list(d.unset);
      return { text: html`${set ? 'Set' : 'Removed'} env vars on ${target}`, sub: [set && `set ${set}`, unset && `removed ${unset}`].filter(Boolean).join(' · ') };
    }
    case 'env.replace': return { text: html`Replaced the env vars of ${target}`, sub: `set ${list(d.set) || 'nothing'} · kept ${list(d.kept) || 'nothing'}` };
    case 'registry.create': return { text: html`Added registry ${target}`, sub: str(d.host) };
    case 'registry.update': return { text: html`Updated registry ${target}${d.tokenChanged ? ' and its token' : ''}`, sub: str(d.host) };
    case 'token.create': return { text: html`Created ${str(d.scope)} token ${target}`, sub: d.expiresAt ? html`expires ${ago(str(d.expiresAt))}` : 'never expires' };
    case 'token.revoke': return { text: html`Revoked token ${target}` };
    case 'settings.set': return { text: html`Changed setting ${target}`, sub: `now ${str(d.value)}` };
    case 'auth.login': return { text: html`Signed in` };
    case 'auth.logout': return { text: html`Signed out` };
    case 'auth.refused': return { text: html`Refused a sign-in`, sub: `${str(d.email)}${d.emailVerified === false ? ' (email not verified)' : ''}` };
    default: return { text: html`${e.action} ${target}` };
  }
}
