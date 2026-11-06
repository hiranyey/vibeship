import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { parseImageRef } from '../docker/image-ref.ts';
import { AppError } from '../errors.ts';
import { icon, type IconName } from './icons.ts';

/**
 * The shared UI components. Every page builds from these, so the rules in
 * vibeship.css hold everywhere:
 *
 * - statuses are a StatusBadge in one of four tones, never orange;
 * - machine values (hostnames, refs, digests, ports, IPs, IDs) are mono,
 *   usually with a CopyButton;
 * - relative times carry the absolute time in `title`;
 * - destructive actions are danger buttons behind the ConfirmDialog.
 */

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

// ——— Times ———

/** "2026-11-06 14:03:22 UTC": the one absolute format, used in every tooltip. ui.js has the same function. */
export function absoluteTime(t: string | number | Date): string {
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** "5m ago", "in 3d", "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  const a = Math.abs(s);
  if (a < 45) return s < 0 ? 'in a moment' : 'just now';
  const text = a < 3600 ? `${Math.round(a / 60)}m` : a < 86_400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86_400)}d`;
  return s < 0 ? `in ${text}` : `${text} ago`;
}

/** A relative time, with the exact time on hover. */
export function ago(iso: string | null | undefined, opts: { now?: number; prefix?: string; never?: string } = {}): Html {
  if (!iso) return html`<span class="text-subtle">${opts.never ?? 'never'}</span>`;
  if (Number.isNaN(Date.parse(iso))) return html`${iso}`;
  return html`<time datetime="${iso}" title="${absoluteTime(iso)}">${opts.prefix ? `${opts.prefix} ` : ''}${relativeTime(iso, opts.now)}</time>`;
}

/** "14:03" for rows grouped under a day header, with the exact time on hover. */
export function clockTime(iso: string): Html {
  return html`<time class="mono" datetime="${iso}" title="${absoluteTime(iso)}">${new Date(iso).toISOString().slice(11, 16)}</time>`;
}

/** "Today", "Yesterday" or "Tue 4 Nov 2026", for day headers (UTC, like every time shown). */
export function dayLabel(iso: string, now = Date.now()): string {
  const day = (t: number) => Math.floor(t / 86_400_000);
  const diff = day(now) - day(Date.parse(iso));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const ms = Date.parse(to) - Date.parse(from);
  if (!(ms >= 0)) return '';
  return ms < 1000 ? `${ms}ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

// ——— StatusBadge and Tag ———

const STATUS: Record<string, { tone: Tone; label: string }> = {
  running: { tone: 'success', label: 'Running' },
  healthy: { tone: 'success', label: 'Healthy' },
  active: { tone: 'success', label: 'Active' },
  deploying: { tone: 'warning', label: 'Deploying' },
  failed: { tone: 'danger', label: 'Failed' },
  stopped: { tone: 'neutral', label: 'Stopped' },
  revoked: { tone: 'neutral', label: 'Revoked' },
  expired: { tone: 'neutral', label: 'Expired' },
  queued: { tone: 'neutral', label: 'Queued' },
  created: { tone: 'neutral', label: 'Not deployed' },
};

/**
 * A status as a dot and a tone: running/healthy/active are success,
 * deploying is warning, failed is danger, the rest neutral. A deploy's
 * `running` status means it is still deploying.
 */
export function statusBadge(status: string, opts: { kind?: 'project' | 'deploy'; label?: string; title?: string; tone?: Tone } = {}): Html {
  const key = opts.kind === 'deploy' && status === 'running' ? 'deploying' : status;
  const s = STATUS[key] ?? { tone: 'neutral' as const, label: status };
  return html`<span class="status tone-${opts.tone ?? s.tone}" data-status="${status}"${opts.title ? html` title="${opts.title}"` : ''}><span class="status-dot" aria-hidden="true"></span>${opts.label ?? s.label}</span>`;
}

/**
 * A neutral label for a kind, a scope or an audit action. Warning tone marks
 * something powerful (admin scope); danger tone marks only destructive
 * actions in the audit log, never a scope.
 */
export function tag(text: string, opts: { tone?: 'neutral' | 'warning' | 'danger' | 'info'; title?: string } = {}): Html {
  return html`<span class="tag${opts.tone && opts.tone !== 'neutral' ? ` tone-${opts.tone}` : ''}"${opts.title ? html` title="${opts.title}"` : ''}>${text}</span>`;
}

// ——— Machine values: CopyButton, digests, links ———

const COPY_ICON = raw('<svg class="copy-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>');
const CHECK_ICON = raw('<svg class="check-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');

/** An icon button that copies `text`; ui.js shows "Copied" and announces it. */
export function copyButton(text: string, label = 'Copy'): Html {
  return html`<button class="copy-btn" type="button" data-copy-text="${text}" aria-label="${label}" title="${label}">${COPY_ICON}${CHECK_ICON}</button>`;
}

/** A machine value in mono with a copy button after it. */
export function copyable(text: string, display?: Html | string, opts: { title?: string } = {}): Html {
  return html`<span class="copyable"><span class="mono"${opts.title ? html` title="${opts.title}"` : ''}>${display ?? text}</span>${copyButton(text, `Copy ${text.length > 40 ? 'value' : text}`)}</span>`;
}

/** The first 7 hex characters of a digest; the full digest on hover and in the copy button. */
export function shortDigest(digest: string | null | undefined, opts: { copy?: boolean } = {}): Html {
  if (!digest) return html`<span class="text-subtle">none</span>`;
  const short = digest.replace(/^sha256:/, '').slice(0, 7);
  return opts.copy === false
    ? html`<span class="mono" title="${digest}">${short}</span>`
    : copyable(digest, short, { title: digest });
}

/** An image's tag next to its short digest: `latest  a1b2c3d ⧉`. */
export function imageVersion(imageRef: string | undefined, digest: string | null | undefined): Html {
  if (!digest) return html`<span class="text-subtle">none</span>`;
  let ref: string | null = null;
  try {
    ref = imageRef ? parseImageRef(imageRef).tag : null;
  } catch { /* a ref we can't parse: show the digest alone */ }
  return html`<span class="version">${ref ? tag(ref) : ''}${shortDigest(digest)}</span>`;
}

/** A link that opens in a new tab, marked with an icon. */
export function externalLink(href: string, text: string): Html {
  return html`<a class="ext-link" href="${href}" target="_blank" rel="noopener noreferrer">${text}${icon('external', 14)}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

// ——— Buttons ———

/**
 * primary (orange), secondary (outline), danger (red outline: Stop…),
 * danger-solid (Delete project…), ghost-danger (a row's Revoke…/Remove…),
 * ghost (Cancel).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-solid' | 'ghost-danger' | 'ghost';
const DANGER: ButtonVariant[] = ['danger', 'danger-solid', 'ghost-danger'];

/** What the ConfirmDialog asks before a form posts. */
export type Confirm = { title: string; body: string; action: string; tone?: 'danger' | 'default' };

function btnClass(variant: ButtonVariant = 'secondary', size?: 'sm' | 'lg', iconOnly = false): string {
  return `btn btn-${variant}${size ? ` btn-${size}` : ''}${iconOnly ? ' btn-icon' : ''}`;
}

/** A link styled as a button. `drawer` makes it open that drawer in place (the href is the no-JS fallback). */
export function linkButton(href: string, label: string, opts: { variant?: ButtonVariant; size?: 'sm' | 'lg'; icon?: IconName; drawer?: string } = {}): Html {
  return html`<a class="${btnClass(opts.variant, opts.size)}" href="${href}"${opts.drawer ? html` data-drawer-open="${opts.drawer}"` : ''}>${opts.icon ? icon(opts.icon, 14) : ''}${label}</a>`;
}

/** The data attributes ui.js turns into a ConfirmDialog before the form posts. */
export function confirmAttrs(c: Confirm | undefined): Html {
  if (!c) return html``;
  return html` data-confirm="${c.body}" data-confirm-title="${c.title}" data-confirm-action="${c.action}" data-confirm-tone="${c.tone ?? 'default'}"`;
}

/**
 * A one-button form that posts to `action`. `destructive` makes it a danger
 * button that asks first; `confirm` asks first without the danger styling.
 */
export function postButton(action: string, label: string, opts: {
  variant?: ButtonVariant; size?: 'sm' | 'lg'; icon?: IconName; hidden?: Record<string, string>;
  destructive?: Omit<Confirm, 'tone'>; confirm?: Confirm; disabledReason?: string;
} = {}): Html {
  // Destructive actions are always one of the danger styles.
  const variant = opts.destructive ? (opts.variant && DANGER.includes(opts.variant) ? opts.variant : 'danger') : opts.variant;
  const confirm = opts.destructive ? { ...opts.destructive, tone: 'danger' as const } : opts.confirm;
  return html`<form class="inline-form" method="post" action="${action}"${confirmAttrs(confirm)}>${
    Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)
  }<button class="${btnClass(variant, opts.size)}" type="submit"${opts.disabledReason ? html` disabled title="${opts.disabledReason}"` : ''}>${opts.icon ? icon(opts.icon, 14) : ''}${label}</button></form>`;
}

// ——— ConfirmDialog and Drawer ———

/** The one ConfirmDialog, rendered once per page; ui.js fills it from a form's data-confirm-* attributes. */
export function confirmDialog(): Html {
  return html`<dialog class="modal" id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body">
    <form class="modal-inner" method="dialog">
      <h2 class="modal-title" id="confirm-title">Are you sure?</h2>
      <p class="modal-body" id="confirm-body"></p>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="submit" value="cancel" autofocus>Cancel</button>
        <button class="btn btn-danger" type="submit" value="confirm" id="confirm-ok">Confirm</button>
      </div>
    </form>
  </dialog>`;
}

/**
 * A panel that slides in from the right with a form: the one creation
 * pattern (New project, Add registry, Create token). `open` renders it open,
 * for a direct link or a form coming back with an error; `closeHref` is
 * where closing it goes without JS.
 */
export function drawer(opts: { id: string; title: string; open?: boolean; wide?: boolean; closeHref: string; body: Html }): Html {
  return html`<dialog class="drawer${opts.wide ? ' is-wide' : ''}" id="${opts.id}" aria-labelledby="${opts.id}-title"${opts.open ? raw(' open data-autoopen') : ''}>
    <div class="drawer-head">
      <h2 class="drawer-title" id="${opts.id}-title">${opts.title}</h2>
      <a class="btn-icon" href="${opts.closeHref}" data-drawer-close aria-label="Close">${icon('close', 18)}</a>
    </div>
    <div class="drawer-body">${opts.body}</div>
  </dialog>`;
}

// ——— PageHeader and containers ———

/** Title (with an optional status), a description, and the primary action at top right. Breadcrumbs live in the top bar. */
export function pageHeader(title: Html | string, description?: Html | string, actions?: Html, opts: { project?: boolean } = {}): Html {
  return html`<header class="page-header${opts.project ? ' is-project' : ''}">
    <div class="page-header-text">
      <h1 class="t-xl page-title">${title}</h1>
      ${description ? html`<div class="page-description">${description}</div>` : ''}
    </div>
    ${actions ? html`<div class="page-header-actions">${actions}</div>` : ''}
  </header>`;
}

/** A callout. `autoDismiss` fades it out after a few seconds (used for success notices). */
export function alert(kind: 'success' | 'danger' | 'info' | 'warning', text: Html | string, title?: string, autoDismiss = false): Html {
  return html`<div class="alert alert-${kind}" role="${kind === 'danger' ? 'alert' : 'status'}"${autoDismiss ? raw(' data-autodismiss') : ''}><div>${
    title ? html`<div class="alert-title">${title}</div>` : ''
  }<div class="alert-body">${text}</div></div></div>`;
}

/** The "shown once" box for a new API token or webhook URL. */
export function shownOnce(label: string, value: string, warning: string): Html {
  return html`<section class="card token-once" aria-label="${label}">
    <div class="token-once-warn">${statusBadge('once', { label: 'Shown once', tone: 'warning' })}<span class="t-sm">${warning}</span></div>
    <div class="label">${label}</div>
    <div class="token-once-row">
      <code class="token-once-value" id="once-value">${value}</code>
      <button class="btn btn-primary" type="button" data-copy="once-value">Copy</button>
    </div>
  </section>`;
}

// ——— DataTable ———

export type Column = string | { label: string; cls?: string; srOnly?: boolean };

/** The actions column: right-aligned, with a header only screen readers see. */
export const ACTIONS: Column = { label: 'Actions', cls: 'cell-actions', srOnly: true };

/** A table in its bordered wrapper, headers in the label role. */
export function dataTable(opts: {
  id?: string; head: Column[]; body: Html | Html[]; compact?: boolean; caption?: string;
  /** Extra class on the table, e.g. a fixed layout. */
  tableClass?: string;
  /** Column widths, as `<col>` classes. */
  cols?: string[];
  /** A quieter, thin-bordered wrapper for secondary tables (revoked tokens). */
  quiet?: boolean;
}): Html {
  return html`<div class="${opts.quiet ? 'panel-quiet' : 'table-wrap'}">
    <table class="table${opts.compact ? ' table-compact' : ''}${opts.tableClass ? ` ${opts.tableClass}` : ''}"${opts.id ? html` id="${opts.id}"` : ''}>
      ${opts.caption ? html`<caption class="sr-only">${opts.caption}</caption>` : ''}
      ${opts.cols ? html`<colgroup>${opts.cols.map((c) => html`<col class="${c}" />`)}</colgroup>` : ''}
      <thead><tr>${opts.head.map((col) => {
        const c = typeof col === 'string' ? { label: col } : col;
        return html`<th scope="col"${c.cls ? html` class="${c.cls}"` : ''}>${c.srOnly ? html`<span class="sr-only">${c.label}</span>` : c.label}</th>`;
      })}</tr></thead>
      ${opts.body}
    </table>
  </div>`;
}

export function emptyRow(cols: number, text: Html | string): Html {
  return html`<tr class="empty-row"><td colspan="${cols}" class="text-muted">${text}</td></tr>`;
}

export function emptyState(title: string, text: Html | string, action?: Html): Html {
  return html`<div class="empty-state"><div class="empty-title">${title}</div><p>${text}</p>${action ?? ''}</div>`;
}

// ——— FormField ———

/** Field errors keyed by input name, from a validation error's issues (`name: …`). */
export type FieldErrors = Record<string, string>;

export function fieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof AppError)) return {};
  const issues = (err.details?.issues ?? []) as Array<{ path: string; message: string }>;
  return Object.fromEntries(issues.filter((i) => i.path).map((i) => [i.path.split('.')[0]!, i.message]));
}

type FieldBase = {
  label: string;
  name: string;
  help?: Html | string;
  error?: string;
  /** Columns in the 12-column form grid; default 6. */
  span?: 2 | 3 | 4 | 6 | 8 | 9 | 12;
  /** Label markup, when it needs more than plain text. */
  labelHtml?: Html;
  /** Element id, when two forms on a page share field names; default `f-<name>`. */
  id?: string;
  /** Shown between the control and its help, e.g. preset buttons. */
  after?: Html;
};

function fieldWrap(o: FieldBase, id: string, control: Html): Html {
  return html`<div class="field${o.span && o.span !== 6 ? ` span-${o.span}` : ''}">
    <label class="field-label" for="${id}">${o.labelHtml ?? o.label}</label>
    ${control}
    ${o.after ?? ''}
    ${o.help ? html`<div class="field-help" id="${id}-help">${o.help}</div>` : ''}
    <div class="field-error" id="${id}-error"${o.error ? '' : raw(' hidden')}>${o.error ?? ''}</div>
  </div>`;
}

function described(o: FieldBase, id: string): Html {
  return html` aria-describedby="${o.help ? `${id}-help ` : ''}${id}-error"${o.error ? raw(' aria-invalid="true"') : ''}`;
}

/**
 * Label, input, helper text and an inline error. Forms are `novalidate`:
 * ui.js checks `required`, `min`, `max` and `pattern` and writes the error
 * here instead of the browser's bubble. Numbers are machine values, so mono.
 */
export function field(o: FieldBase & {
  value?: string | number | null;
  type?: string;
  placeholder?: string;
  required?: boolean;
  /** False for inputs that hold words (a name, a note); default mono. */
  mono?: boolean;
  narrow?: boolean;
  /** Extra attributes, trusted markup. */
  attrs?: string;
}): Html {
  const id = o.id ?? `f-${o.name}`;
  const type = o.type ?? 'text';
  // Inputs hold machine values (mono) unless told they hold words.
  const words = o.mono === false;
  const input = html`<input class="input${words ? ' input-ui' : ''}${o.narrow ? ' input-narrow' : ''}" id="${id}" name="${o.name}" type="${type}"
      value="${o.value ?? ''}"${o.placeholder ? html` placeholder="${o.placeholder}"` : ''}${o.required ? raw(' required') : ''}${described(o, id)}${o.attrs ? raw(` ${o.attrs}`) : ''} />`;
  const control = type === 'password'
    ? html`<div class="input-group">${input}<button class="btn-icon" type="button" data-reveal="${id}" aria-pressed="false" aria-label="Show ${o.label.toLowerCase()}">${icon('eye', 18)}${icon('eye-off', 18)}</button></div>`
    : input;
  return fieldWrap(o, id, control);
}

export function selectField(o: FieldBase & { value?: string; options: Array<{ value: string; label: string }> }): Html {
  const id = o.id ?? `f-${o.name}`;
  return fieldWrap(o, id, html`<select class="select" id="${id}" name="${o.name}"${described(o, id)}>
      ${o.options.map((opt) => html`<option value="${opt.value}"${opt.value === (o.value ?? '') ? raw(' selected') : ''}>${opt.label}</option>`)}
    </select>`);
}

/** A textarea; `code` for YAML and KEY=value lines (mono, tinted). */
export function textarea(o: FieldBase & { value?: string | null; code?: boolean; rows?: number; placeholder?: string; required?: boolean }): Html {
  const id = o.id ?? `f-${o.name}`;
  return fieldWrap(o, id, html`<textarea class="textarea${o.code ? ' textarea-code' : ' input-ui'}" id="${id}" name="${o.name}" rows="${o.rows ?? 6}" spellcheck="false"${
    o.placeholder ? html` placeholder="${o.placeholder}"` : ''
  }${o.required ? raw(' required') : ''}${described(o, id)}>${o.value ?? ''}</textarea>`);
}

/** Radio cards: each option with a one-line description. */
export function choiceGroup(o: { legend: string; name: string; value: string; options: Array<{ value: string; title: string; desc: string }>; span?: FieldBase['span']; mono?: boolean }): Html {
  return html`<fieldset class="choice-group${o.span && o.span !== 6 ? ` span-${o.span}` : ''}">
    <legend class="field-label">${o.legend}</legend>
    ${o.options.map((opt) => html`<label class="choice">
      <input type="radio" name="${o.name}" value="${opt.value}"${opt.value === o.value ? raw(' checked') : ''} />
      <span class="choice-title${o.mono ? ' mono' : ''}">${opt.title}</span>
      <span class="choice-desc">${opt.desc}</span>
    </label>`)}
  </fieldset>`;
}

export function checkbox(label: Html | string, name: string, checked = false, opts: { danger?: boolean } = {}): Html {
  return html`<label class="checkbox${opts.danger ? ' is-danger' : ''}"><input type="checkbox" name="${name}"${checked ? raw(' checked') : ''} /><span>${label}</span></label>`;
}

/** Radio chips: one of a few presets (token expiry). */
export function presetGroup(o: { legend: string; name: string; value: string; options: Array<{ value: string; label: string }>; span?: FieldBase['span']; after?: Html }): Html {
  return html`<fieldset class="presets-field${o.span && o.span !== 6 ? ` span-${o.span}` : ''}">
    <legend class="field-label">${o.legend}</legend>
    <div class="presets">${o.options.map((opt) => html`<label class="preset"><input type="radio" name="${o.name}" value="${opt.value}"${opt.value === o.value ? raw(' checked') : ''} /><span class="chip">${opt.label}</span></label>`)}</div>
    ${o.after ?? ''}
  </fieldset>`;
}
