import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Config } from '../config.ts';
import type { AppEnv } from '../http/auth.ts';
import { cookieSettings } from '../http/auth.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type Nav = 'projects' | 'new' | 'registries' | 'tokens' | 'audit' | 'settings' | null;

type Flash = { kind: 'success' | 'danger' | 'info' | 'warning'; text: string };

/**
 * Security headers for every UI page: scripts only from Vibeship itself
 * (`/ui.js`), no framing, and forms that can only post back here.
 */
/** The `<head>` tags for the favicon, touch icon and manifest, shared by every page. */
export const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#f3eee4" />`;

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const NAV: Array<{ key: Exclude<Nav, null>; href: string; label: string }> = [
  { key: 'projects', href: '/', label: 'Projects' },
  { key: 'new', href: '/projects/new', label: 'New project' },
  { key: 'registries', href: '/settings/registries', label: 'Registries' },
  { key: 'tokens', href: '/settings/tokens', label: 'API tokens' },
  { key: 'audit', href: '/settings/audit', label: 'Audit log' },
  { key: 'settings', href: '/settings', label: 'Settings' },
];

export type PageOptions = {
  title: string;
  nav?: Nav;
  /** Breadcrumb trail; the last entry is the current page. */
  crumbs?: Array<{ label: string; href?: string }>;
  body: Html;
  status?: 200 | 400 | 403 | 404 | 409 | 500 | 503;
};

/** Renders full pages and carries one-shot notices across redirects. */
export class View {
  readonly #config: Pick<Config, 'publicUrl'>;
  readonly #flashCookie: string;
  readonly #secure: boolean;

  constructor(config: Pick<Config, 'publicUrl'>) {
    this.#config = config;
    const cookies = cookieSettings(config);
    this.#flashCookie = cookies.flash;
    this.#secure = cookies.secure;
  }

  /** The address an app is served at, with the same scheme and port as Vibeship. */
  appUrl(hostname: string): string {
    const u = new URL(this.#config.publicUrl);
    return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}`;
  }

  get publicUrl(): string {
    return this.#config.publicUrl;
  }

  flash(c: Context, kind: Flash['kind'], text: string): void {
    setCookie(c, this.#flashCookie, Buffer.from(JSON.stringify({ kind, text })).toString('base64url'), {
      httpOnly: true,
      secure: this.#secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60,
    });
  }

  /** Sets a notice and redirects with 303, so a reload doesn't repost the form. */
  redirect(c: Context, to: string, kind?: Flash['kind'], text?: string): Response {
    if (kind && text) this.flash(c, kind, text);
    return c.redirect(to, 303);
  }

  #takeFlash(c: Context): Flash | null {
    const value = getCookie(c, this.#flashCookie);
    if (!value) return null;
    deleteCookie(c, this.#flashCookie, { path: '/', secure: this.#secure });
    try {
      const f = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Flash;
      if (!['success', 'danger', 'info', 'warning'].includes(f.kind) || typeof f.text !== 'string') return null;
      return { kind: f.kind, text: f.text.slice(0, 1000) };
    } catch {
      return null;
    }
  }

  render(c: Context<AppEnv>, opts: PageOptions): Response | Promise<Response> {
    const p = c.get('principal');
    const user = p?.kind === 'user' ? p.user : null;
    const flash = this.#takeFlash(c);
    const host = new URL(this.#config.publicUrl).host;
    const crumbs = opts.crumbs ?? [];
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cache-Control', 'no-store');

    const page = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${opts.title} · Vibeship</title>
    ${raw(ICON_LINKS)}
    <link rel="stylesheet" href="/static/vibeship.css" />
    <script src="/static/ui.js" defer></script>
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <a class="topbar-brand" href="/">
          <img class="brand-mark" src="/static/vibeship-mark.svg" alt="" width="28" height="28" />
          <div>
            <div class="brand-title">Vibeship</div>
          </div>
        </a>
        <nav class="breadcrumb" aria-label="Breadcrumb">
          ${crumbs.map((cr, i) => html`${i > 0 ? html`<span class="breadcrumb-sep">/</span>` : ''}${
            cr.href && i < crumbs.length - 1 ? html`<a href="${cr.href}">${cr.label}</a>` : html`<span class="breadcrumb-current">${cr.label}</span>`
          }`)}
        </nav>
        <div class="topbar-right">
          ${user
            ? html`<form method="post" action="/auth/logout"><button class="btn btn-ghost btn-sm" type="submit">Log out</button></form>`
            : ''}
        </div>
      </header>
      <div class="shell-body">
        ${user
          ? html`<aside class="sidebar" aria-label="Primary">
              <div class="label-caps">Navigate</div>
              ${NAV.map((n) => html`<a class="nav-item${n.key === opts.nav ? ' is-active' : ''}" href="${n.href}"${n.key === opts.nav ? raw(' aria-current="page"') : ''}>${n.label}</a>`)}
              <div class="sidebar-footer">
                <div class="sidebar-footer-head">MCP ${copyButton(`${this.#config.publicUrl}/mcp`, 'Copy the MCP URL')}</div>
                <span class="mono">${this.#config.publicUrl}/mcp</span>
              </div>
            </aside>`
          : ''}
        <main class="main">
          ${flash ? alert(flash.kind, flash.text, undefined, flash.kind === 'success') : ''}
          ${opts.body}
        </main>
      </div>
    </div>
  </body>
</html>`;
    return c.html(page, opts.status ?? 200);
  }

  /** A page for an error outside the normal flow, e.g. a missing project. */
  error(c: Context<AppEnv>, status: PageOptions['status'], title: string, message: string): Response | Promise<Response> {
    return this.render(c, {
      title,
      status,
      body: html`<div class="page-header"><h1 class="t-xl">${title}</h1></div>
        ${alert('danger', message)}
        <p><a href="/">Back to projects</a></p>`,
    });
  }
}

function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** A callout. `autoDismiss` fades it out after a few seconds (used for success notices). */
export function alert(kind: Flash['kind'], text: Html | string, title?: string, autoDismiss = false): Html {
  return html`<div class="alert alert-${kind}" role="${kind === 'danger' ? 'alert' : 'status'}"${autoDismiss ? raw(' data-autodismiss') : ''}><div>${
    title ? html`<div class="alert-title">${title}</div>` : ''
  }<div class="alert-body">${text}</div></div></div>`;
}

const PILL: Record<string, string> = {
  running: 'running',
  healthy: 'running',
  deploying: 'deploying',
  running_deploy: 'deploying',
  failed: 'failed',
  stopped: 'stopped',
  queued: 'queued',
  created: 'queued',
};

/** A status pill for a project status or a deploy status. */
export function pill(status: string, kind: 'project' | 'deploy' = 'project'): Html {
  const cls = kind === 'deploy' && status === 'running' ? 'deploying' : PILL[status] ?? 'queued';
  return html`<span class="pill pill-${cls}" data-status="${status}"><span class="pill-dot"></span>${status}</span>`;
}

export function pageHeader(title: Html | string, subtitle?: Html | string, actions?: Html): Html {
  return html`<div class="page-header">
    <div>
      <h1 class="t-xl page-title">${title}</h1>
      ${subtitle ? html`<p class="text-muted t-sm page-subtitle">${subtitle}</p>` : ''}
    </div>
    ${actions ? html`<div class="page-header-actions">${actions}</div>` : ''}
  </div>`;
}

/** "5m ago", with the exact time on hover. */
export function ago(iso: string | null | undefined, now = Date.now()): Html {
  if (!iso) return html`<span class="text-subtle">never</span>`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return html`${iso}`;
  const s = Math.round((now - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const text = a < 45 ? (future ? 'in a moment' : 'just now')
    : a < 3600 ? `${Math.round(a / 60)}m`
    : a < 86_400 ? `${Math.round(a / 3600)}h`
    : `${Math.round(a / 86_400)}d`;
  const label = a < 45 ? text : future ? `in ${text}` : `${text} ago`;
  return html`<time datetime="${iso}" title="${new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}">${label}</time>`;
}

/** sha256:abcdef123456… for tables; the full digest on hover. */
export function shortDigest(digest: string | null | undefined): Html {
  if (!digest) return html`<span class="text-subtle">none</span>`;
  return html`<span class="mono" title="${digest}">${digest.slice(0, 19)}…</span>`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const ms = Date.parse(to) - Date.parse(from);
  if (!(ms >= 0)) return '';
  return ms < 1000 ? `${ms}ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

/** A form field with label, help and error. */
export function field(opts: {
  label: string;
  name: string;
  value?: string | number | null;
  type?: string;
  help?: Html | string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  attrs?: string;
}): Html {
  const id = `f-${opts.name}`;
  return html`<div class="field">
    <label class="field-label" for="${id}">${opts.label}</label>
    <input class="input${opts.mono ? ' input-mono' : ''}" id="${id}" name="${opts.name}" type="${opts.type ?? 'text'}"
      value="${opts.value ?? ''}"${opts.placeholder ? html` placeholder="${opts.placeholder}"` : ''}${opts.required ? raw(' required') : ''}${opts.attrs ? raw(` ${opts.attrs}`) : ''} />
    ${opts.help ? html`<div class="field-help">${opts.help}</div>` : ''}
  </div>`;
}

export function textarea(opts: { label: string; name: string; value?: string | null; help?: Html | string; yaml?: boolean; rows?: number; placeholder?: string }): Html {
  const id = `f-${opts.name}`;
  return html`<div class="field">
    <label class="field-label" for="${id}">${opts.label}</label>
    <textarea class="textarea${opts.yaml ? ' textarea-yaml' : ' input-mono'}" id="${id}" name="${opts.name}" rows="${opts.rows ?? 6}" spellcheck="false"${
      opts.placeholder ? html` placeholder="${opts.placeholder}"` : ''
    }>${opts.value ?? ''}</textarea>
    ${opts.help ? html`<div class="field-help">${opts.help}</div>` : ''}
  </div>`;
}

/** A one-button form that posts to `action`, optionally asking for confirmation first. */
export function postButton(action: string, label: string, opts: { cls?: string; confirm?: string; hidden?: Record<string, string> } = {}): Html {
  return html`<form class="inline-form" method="post" action="${action}"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ''}>${
    Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)
  }<button class="btn ${opts.cls ?? 'btn-secondary'}" type="submit">${label}</button></form>`;
}

/** The "shown once" box for a new API token or webhook URL. */
export function shownOnce(label: string, value: string, warning: string): Html {
  return html`<div class="token-once">
    <div class="token-once-warn">${warning}</div>
    <div class="label-caps">${label}</div>
    <div class="token-once-row">
      <code class="token-once-value" id="once-value">${value}</code>
      <button class="btn btn-primary btn-sm" type="button" data-copy="once-value">Copy</button>
    </div>
  </div>`;
}

export function emptyRow(cols: number, text: Html | string): Html {
  return html`<tr class="empty-row"><td colspan="${cols}" class="text-muted">${text}</td></tr>`;
}

const COPY_ICON = raw('<svg class="copy-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>');
const CHECK_ICON = raw('<svg class="check-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');

/** A small icon button that copies `text` to the clipboard (handled by ui.js). */
export function copyButton(text: string, label = 'Copy'): Html {
  return html`<button class="copy-btn" type="button" data-copy-text="${text}" aria-label="${label}" title="${label}">${COPY_ICON}${CHECK_ICON}</button>`;
}

/** `text` in monospace with a copy button after it. */
export function copyable(text: string, display?: Html | string): Html {
  return html`<span class="copyable"><span class="mono">${display ?? text}</span>${copyButton(text, `Copy ${text.length > 40 ? 'value' : text}`)}</span>`;
}
