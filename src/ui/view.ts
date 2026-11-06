import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import type { Config } from '../config.ts';
import type { AppEnv } from '../http/auth.ts';
import { cookieSettings } from '../http/auth.ts';
import { assetUrl } from './assets.ts';
import { alert, confirmDialog, type Html, pageHeader } from './components.ts';
import { icon, type IconName } from './icons.ts';

export type { Html } from './components.ts';

export type Nav = 'projects' | 'registries' | 'tokens' | 'audit' | 'settings' | null;

type Flash = { kind: 'success' | 'danger' | 'info' | 'warning'; text: string };

/** The `<head>` tags for the favicon, touch icon and manifest, shared by every page. */
export const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#F3EEE6" />`;

/**
 * Security headers for every UI page: scripts only from Vibeship itself
 * (`/ui.js`), no framing, and forms that can only post back here.
 */
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

const NAV: Array<{ key: Exclude<Nav, null>; href: string; label: string; icon: IconName }> = [
  { key: 'projects', href: '/', label: 'Projects', icon: 'projects' },
  { key: 'registries', href: '/registries', label: 'Registries', icon: 'registries' },
  { key: 'tokens', href: '/tokens', label: 'API tokens', icon: 'tokens' },
  { key: 'audit', href: '/audit', label: 'Audit log', icon: 'audit' },
  { key: 'settings', href: '/settings', label: 'Settings', icon: 'settings' },
];

/** Set by ui.js when the sidebar is collapsed to icons, so the next page renders that way without a flash. */
const SIDEBAR_COOKIE = 'vs_sidebar';

export type PageOptions = {
  title: string;
  nav?: Nav;
  /** Breadcrumb trail, shown in the top bar; the last entry is the current page. Labels match page and tab names. */
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
    const crumbs = opts.crumbs ?? [];
    const collapsed = getCookie(c, SIDEBAR_COOKIE) === 'collapsed';
    const mcpUrl = `${this.#config.publicUrl}/mcp`;
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cache-Control', 'no-store');

    const page = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${opts.title} · Vibeship</title>
    ${raw(ICON_LINKS)}
    <link rel="stylesheet" href="${assetUrl('vibeship.css')}" />
    <script src="${assetUrl('ui.js')}" defer></script>
  </head>
  <body>
    <div class="app-shell${collapsed ? ' sidebar-collapsed' : ''}">
      <header class="topbar">
        <div class="topbar-left">
          <a class="topbar-brand" href="/" aria-label="Vibeship home">
            <img class="brand-mark" src="/favicon.svg" alt="" width="30" height="30" />
            <span class="brand-title">Vibeship</span>
          </a>
          ${crumbs.length > 0
            ? html`<nav class="breadcrumb" aria-label="Breadcrumb">${crumbs.map((cr, i) => html`<span class="breadcrumb-sep" aria-hidden="true">/</span>${
                cr.href && i < crumbs.length - 1 ? html`<a href="${cr.href}">${cr.label}</a>` : html`<span class="breadcrumb-current" aria-current="page">${cr.label}</span>`
              }`)}</nav>`
            : ''}
        </div>
        <div class="topbar-right">${user ? userMenu(user.email) : ''}</div>
      </header>
      <div class="shell-body">
        ${user
          ? html`<aside class="sidebar" aria-label="Primary">
              ${NAV.map((n) => navItem(n.href, n.label, n.icon, n.key === opts.nav))}
              <div class="sidebar-footer">
                <span class="tooltip-wrap">
                  <button class="nav-item" type="button" data-copy-text="${mcpUrl}" aria-label="Connect MCP: copy the MCP URL, ${mcpUrl}" title="Copies ${mcpUrl}">${icon('mcp', 18)}<span class="nav-label">Connect MCP</span></button>
                  <span class="tooltip tooltip-right" aria-hidden="true">Copy the MCP URL · ${mcpUrl}</span>
                </span>
                <span class="tooltip-wrap sidebar-toggle">
                  <button class="nav-item" type="button" data-sidebar-toggle aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Show labels' : 'Hide labels'}">${icon('chevron', 16)}<span class="nav-label">Hide labels</span></button>
                  <span class="tooltip tooltip-right" aria-hidden="true">Show labels</span>
                </span>
              </div>
            </aside>`
          : ''}
        <main class="main" id="main">
          <div class="content">
            ${flash ? alert(flash.kind, flash.text, undefined, flash.kind === 'success') : ''}
            ${opts.body}
          </div>
        </main>
      </div>
    </div>
    ${user ? confirmDialog() : ''}
    <div class="sr-only" role="status" aria-live="polite" id="live-region"></div>
  </body>
</html>`;
    return c.html(page, opts.status ?? 200);
  }

  /** A page for an error outside the normal flow, e.g. a missing project. */
  error(c: Context<AppEnv>, status: PageOptions['status'], title: string, message: string): Response | Promise<Response> {
    return this.render(c, {
      title,
      status,
      crumbs: [{ label: title }],
      body: html`${pageHeader(title)}
        ${alert('danger', message)}
        <p><a href="/">Back to projects</a></p>`,
    });
  }
}

/** A sidebar link: icon, a tooltip while collapsed, the label once expanded. */
function navItem(href: string, label: string, name: IconName, active: boolean): Html {
  return html`<span class="tooltip-wrap">
    <a class="nav-item${active ? ' is-active' : ''}" href="${href}" aria-label="${label}"${active ? raw(' aria-current="page"') : ''}>${icon(name, 18)}<span class="nav-label">${label}</span></a>
    <span class="tooltip tooltip-right" aria-hidden="true">${label}</span>
  </span>`;
}

/** One letter for the avatar: the email's first. */
export function initials(email: string): string {
  return (email.trim()[0] ?? '?').toUpperCase();
}

/** The signed-in email and Log out, behind the avatar. Works without JS (details/summary). */
function userMenu(email: string): Html {
  return html`<details class="user-menu">
    <summary class="user-menu-trigger" aria-label="Account: ${email}">
      <span class="avatar" aria-hidden="true">${initials(email)}</span>
      <span class="user-menu-email">${email}</span>
      ${icon('chevron-down', 14)}
    </summary>
    <div class="dropdown-menu">
      <div class="dropdown-meta">
        <div class="dropdown-meta-label">Signed in as</div>
        <div class="dropdown-meta-value">${email}</div>
      </div>
      <form method="post" action="/auth/logout"><button class="dropdown-item" type="submit">${icon('logout', 16)}Log out</button></form>
    </div>
  </details>`;
}
