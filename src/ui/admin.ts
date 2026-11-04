import { type Context, Hono } from 'hono';
import { html, raw } from 'hono/html';
import { AppError } from '../errors.ts';
import { type AppEnv, principal } from '../http/auth.ts';
import type { AuditEntry } from '../services/audit.ts';
import type { Registry } from '../services/registries.ts';
import type { Services } from '../services/index.ts';
import { readForm } from './projects.ts';
import { ago, alert, emptyRow, field, type Html, pageHeader, postButton, shownOnce, type View } from './view.ts';

const PAGE = 50;

const message = (err: unknown): string => {
  if (err instanceof AppError) return err.message;
  console.error(err);
  return 'Something went wrong; see the Vibeship logs.';
};

/** Registries, API tokens, the audit log and general settings. */
export function adminPages(deps: { services: Services; view: View }): Hono<AppEnv> {
  const { services: s, view } = deps;
  const app = new Hono<AppEnv>();
  const ctx = (c: Context<AppEnv>) => principal(c).ctx;
  const crumbs = (label: string) => [{ label: 'Settings', href: '/settings' }, { label }];

  // Registries

  const registriesPage = (c: Context<AppEnv>, f: Record<string, string> = {}, error?: string) => {
    const list = s.registries.list();
    return view.render(c, {
      title: 'Registries',
      nav: 'registries',
      status: error ? 400 : 200,
      crumbs: crumbs('Registries'),
      body: html`${pageHeader('Registries', 'Logins for pulling private images. A project uses the login whose host matches its image, unless it names one.')}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>Host</th><th>URL</th><th>Login</th><th></th></tr></thead>
            <tbody>${list.length === 0
              ? emptyRow(5, 'No registries. Public images need none.')
              : list.map((r) => html`<tr><td class="cell-name">${r.name}</td><td class="cell-mono">${r.host}</td><td class="cell-mono">${r.url}</td><td>${r.username ? html`<span class="mono">${r.username}</span> · token set` : 'anonymous'}</td><td class="cell-actions"><a class="btn btn-ghost btn-sm" href="/settings/registries/${r.id}">Edit</a></td></tr>`)}</tbody>
          </table>
        </div>
        ${error ? alert('danger', error, 'Not added') : ''}
        <form class="card card-pad form-stack" method="post" action="/settings/registries">
          <h2 class="section-title">Add a registry</h2>
          <div class="form-grid">
            ${field({ label: 'Name', name: 'name', value: f.name, required: true, placeholder: 'RepoFlow' })}
            ${field({ label: 'URL', name: 'url', value: f.url, required: true, mono: true, placeholder: 'https://repoflow.example.com' })}
            ${field({ label: 'Username', name: 'username', value: f.username, mono: true, attrs: 'autocomplete="off"' })}
            ${field({ label: 'Token', name: 'token', type: 'password', mono: true, help: 'Use a read-only token. Encrypted at rest and never shown again.', attrs: 'autocomplete="new-password"' })}
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Add registry</button></div>
        </form>`,
    });
  };

  app.get('/settings/registries', (c) => registriesPage(c));
  app.post('/settings/registries', async (c) => {
    const f = await readForm(c);
    try {
      const r = s.registries.create(ctx(c), {
        name: f.name, url: f.url, username: f.username?.trim() || null, token: f.token || null,
      });
      return view.redirect(c, '/settings/registries', 'success', `Added ${r.name}.`);
    } catch (err) {
      return registriesPage(c, f, message(err));
    }
  });

  const registryById = (c: Context<AppEnv>) => {
    const id = c.req.param('id');
    if (!id || !/^\d{1,15}$/.test(id)) throw new AppError('not_found', 'Registry not found');
    return s.registries.get(Number(id));
  };

  const editRegistryPage = (c: Context<AppEnv>, r: Registry, f?: Record<string, string>, error?: string) => {
    const v = f ?? { name: r.name, url: r.url, username: r.username ?? '' };
    return view.render(c, {
      title: `Edit ${r.name}`,
      nav: 'registries',
      status: error ? 400 : 200,
      crumbs: [{ label: 'Settings', href: '/settings' }, { label: 'Registries', href: '/settings/registries' }, { label: r.name }],
      body: html`${pageHeader(`Edit ${r.name}`, 'Changes apply to the next pull. Projects that name this registry keep using it.')}
        ${error ? alert('danger', error, 'Not saved') : ''}
        <form class="card card-pad form-stack" method="post" action="/settings/registries/${r.id}">
          <div class="form-grid">
            ${field({ label: 'Name', name: 'name', value: v.name, required: true })}
            ${field({ label: 'URL', name: 'url', value: v.url, required: true, mono: true })}
            ${field({ label: 'Username', name: 'username', value: v.username, mono: true, help: 'Clear it to pull anonymously; that also removes the token.', attrs: 'autocomplete="off"' })}
            ${field({
              label: 'Token', name: 'token', type: 'password', mono: true,
              help: r.hasToken ? 'Leave blank to keep the current token. Encrypted at rest and never shown again.' : 'Use a read-only token. Encrypted at rest and never shown again.',
              attrs: 'autocomplete="new-password"',
            })}
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><a class="btn btn-ghost" href="/settings/registries">Cancel</a></div>
        </form>`,
    });
  };

  app.get('/settings/registries/:id', (c) => editRegistryPage(c, registryById(c)));
  app.post('/settings/registries/:id', async (c) => {
    const r = registryById(c);
    const f = await readForm(c);
    try {
      const updated = s.registries.update(ctx(c), r.id, {
        name: f.name, url: f.url, username: f.username?.trim() || null, token: f.token || undefined,
      });
      return view.redirect(c, '/settings/registries', 'success', `Saved ${updated.name}.`);
    } catch (err) {
      return editRegistryPage(c, r, f, message(err));
    }
  });

  // API tokens

  const tokensPage = (c: Context<AppEnv>, extra: { created?: { token: string; name: string }; error?: string; form?: Record<string, string> } = {}) => {
    const tokens = s.tokens.list();
    const f = extra.form ?? {};
    return view.render(c, {
      title: 'API tokens',
      nav: 'tokens',
      status: extra.error ? 400 : 200,
      crumbs: crumbs('API tokens'),
      body: html`${pageHeader('API tokens', html`For the HTTP API and MCP at <span class="mono">${view.publicUrl}/mcp</span>. read sees everything but secrets; deploy also creates, configures and deploys; admin also deletes and manages tokens.`)}
        ${extra.created ? shownOnce(`Token "${extra.created.name}"`, extra.created.token, 'Shown once. Copy it now; it cannot be read back.') : ''}
        ${extra.created ? html`<p class="t-sm text-muted mt-0">For Claude Code: <code class="inline">claude mcp add --transport http vibeship ${view.publicUrl}/mcp --header "Authorization: Bearer ${extra.created.token}"</code></p>` : ''}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th>Expires</th><th>State</th><th></th></tr></thead>
            <tbody>${tokens.length === 0
              ? emptyRow(7, 'No tokens.')
              : tokens.map((t) => {
                const expired = t.expiresAt !== null && Date.parse(t.expiresAt) <= Date.now();
                const state = t.revokedAt ? 'revoked' : expired ? 'expired' : 'active';
                return html`<tr>
                  <td class="cell-name">${t.name}</td>
                  <td><span class="badge badge-scope-${t.scope}">${t.scope}</span></td>
                  <td>${ago(t.createdAt)}</td>
                  <td>${ago(t.lastUsedAt)}</td>
                  <td>${t.expiresAt ? ago(t.expiresAt) : html`<span class="text-subtle">never</span>`}</td>
                  <td>${state}</td>
                  <td class="cell-actions">${state === 'active' ? postButton(`/settings/tokens/${t.id}/revoke`, 'Revoke', { cls: 'btn-ghost btn-sm', confirm: `Revoke ${t.name}? Anything using it stops working at once.` }) : ''}</td>
                </tr>`;
              })}</tbody>
          </table>
        </div>
        ${extra.error ? alert('danger', extra.error, 'Not created') : ''}
        <form class="card card-pad form-stack" method="post" action="/settings/tokens">
          <h2 class="section-title">New token</h2>
          <div class="form-grid">
            ${field({ label: 'Name', name: 'name', value: f.name, required: true, placeholder: 'claude-code laptop' })}
            <div class="field">
              <label class="field-label" for="f-scope">Scope</label>
              <select class="select" id="f-scope" name="scope">
                ${(['read', 'deploy', 'admin'] as const).map((sc) => html`<option value="${sc}"${(f.scope ?? 'deploy') === sc ? raw(' selected') : ''}>${sc}</option>`)}
              </select>
            </div>
            ${field({ label: 'Expires on', name: 'expiresOn', value: f.expiresOn, type: 'date', help: 'Optional; at 00:00 UTC that day.' })}
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Create token</button></div>
        </form>`,
    });
  };

  app.get('/settings/tokens', (c) => tokensPage(c));
  app.post('/settings/tokens', async (c) => {
    const f = await readForm(c);
    try {
      const expiresOn = f.expiresOn?.trim();
      if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new AppError('validation', 'expiresOn: use YYYY-MM-DD');
      const { token, apiToken } = s.tokens.create(ctx(c), {
        name: f.name, scope: f.scope, expiresAt: expiresOn ? `${expiresOn}T00:00:00Z` : null,
      });
      return tokensPage(c, { created: { token, name: apiToken.name } });
    } catch (err) {
      return tokensPage(c, { error: message(err), form: f });
    }
  });
  app.post('/settings/tokens/:id/revoke', (c) => {
    const id = Number(c.req.param('id'));
    try {
      if (!Number.isInteger(id) || id < 1) throw new AppError('not_found', 'Token not found');
      const t = s.tokens.revoke(ctx(c), id);
      return view.redirect(c, '/settings/tokens', 'success', `Revoked ${t.name}.`);
    } catch (err) {
      return view.redirect(c, '/settings/tokens', 'danger', message(err));
    }
  });

  // Audit log

  app.get('/settings/audit', (c) => {
    const before = Number(c.req.query('before') ?? '') || undefined;
    const entries = s.audit.list({ limit: PAGE, beforeId: before });
    const who = actorNames(s);
    return view.render(c, {
      title: 'Audit log',
      nav: 'audit',
      crumbs: crumbs('Audit log'),
      body: html`${pageHeader('Audit log', 'Every change, by whom and from where. Secret values are never recorded.')}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>${entries.length === 0
              ? emptyRow(6, 'Nothing here.')
              : entries.map((e) => html`<tr>
                <td>${ago(e.ts)}</td>
                <td>${who(e)}</td>
                <td class="cell-mono">${e.action}</td>
                <td class="cell-mono">${e.target ?? ''}</td>
                <td class="cell-mono cell-wrap">${Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td>
                <td class="cell-mono">${e.ip ?? ''}</td>
              </tr>`)}</tbody>
          </table>
        </div>
        <div class="row">
          ${before ? html`<a class="btn btn-secondary btn-sm" href="/settings/audit">Newest</a>` : ''}
          ${entries.length === PAGE ? html`<a class="btn btn-secondary btn-sm" href="/settings/audit?before=${entries.at(-1)!.id}">Older</a>` : ''}
        </div>`,
    });
  });

  // General settings

  const settingsPage = (c: Context<AppEnv>, error?: string, value?: string) => view.render(c, {
    title: 'Settings',
    nav: 'settings',
    status: error ? 400 : 200,
    crumbs: [{ label: 'Settings' }],
    body: html`${pageHeader('Settings')}
      ${error ? alert('danger', error, 'Not saved') : ''}
      <form class="card card-pad form-stack" method="post" action="/settings">
        <h2 class="section-title">Deploys</h2>
        ${field({
          label: 'Health check timeout (seconds)', name: 'health_timeout_seconds', type: 'number', required: true,
          value: value ?? s.settings.get('health_timeout_seconds'),
          help: 'How long a new version has to become healthy before the deploy fails and the last healthy version comes back.',
        })}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
      <div class="card card-pad">
        <h2 class="section-title">Elsewhere</h2>
        <ul class="t-sm">
          <li><a href="/settings/registries">Registries</a> for private images</li>
          <li><a href="/settings/tokens">API tokens</a> for CI scripts and MCP agents</li>
          <li><a href="/settings/audit">Audit log</a></li>
        </ul>
      </div>`,
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

/** Labels audit actors by email or token name, looking each up once. */
function actorNames(s: Services): (e: AuditEntry) => Html {
  const users = new Map<number, string>();
  const tokens = new Map<number, string>();
  return (e) => {
    if (e.actorType === 'user' && e.userId !== null) {
      if (!users.has(e.userId)) users.set(e.userId, s.sessions.getUser(e.userId)?.email ?? `user ${e.userId}`);
      return html`${users.get(e.userId)}`;
    }
    if (e.actorType === 'token' && e.tokenId !== null) {
      if (!tokens.has(e.tokenId)) {
        let name = `token ${e.tokenId}`;
        try {
          name = `token ${s.tokens.get(e.tokenId).name}`;
        } catch { /* deleted */ }
        tokens.set(e.tokenId, name);
      }
      return html`${tokens.get(e.tokenId)}`;
    }
    return html`<span class="text-muted">system</span>`;
  };
}
