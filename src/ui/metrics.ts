import { html } from 'hono/html';
import type { Html } from './components.ts';

/**
 * CPU and memory. They render with placeholders; ui.js fetches the latest
 * numbers (`docker stats` takes a second or two, so pages don't wait for it)
 * and refreshes them every few seconds. ui.js finds the parts by
 * `data-bind` (text) and `data-bar` (meter width in %).
 */

const DASH = '—';

/** The "updated 14:03:22 UTC" line; ui.js fills it with the same format as every other time. */
const updated = html`<span class="metrics-updated"><span class="live-dot" aria-hidden="true"></span><span data-bind="updated">loading…</span></span>`;
const dockerError = html`<div class="alert alert-warning" data-bind-error hidden><div><div class="alert-title">Docker did not answer</div><div class="alert-body" data-bind="error"></div></div></div>`;

/** One card: a label, a big number, a line of detail and a meter. */
function tile(key: string, label: string, hint: string, secondary = false): Html {
  return html`<div class="metric-card${secondary ? ' is-secondary' : ''}" data-tile="${key}">
    <div class="metric-label">${label}</div>
    <div class="metric-value"><span data-bind="${key}">${DASH}</span><span class="metric-unit" data-bind="${key}-unit"></span></div>
    <div class="metric-sub" data-bind="${key}-sub">${hint}</div>
    <div class="meter" aria-hidden="true"><div class="meter-fill" data-bar="${key}"></div></div>
  </div>`;
}

/** One figure in the server strip: label, value, detail. */
function stat(key: string, label: string): Html {
  return html`<span class="server-stat">
    <span class="label">${label}</span>
    <span class="server-stat-value"><span data-bind="${key}">${DASH}</span><span data-bind="${key}-unit"></span></span>
    <span class="server-stat-sub" data-bind="${key}-sub"></span>
  </span>`;
}

/** The VM, and what all projects use of it: one compact strip under the dashboard's project list. */
export function hostPanel(): Html {
  return html`<section class="metrics server-strip" data-metrics="/api/metrics" data-metrics-kind="overview" aria-label="Server" aria-busy="true">
    <h2 class="server-strip-title">Server</h2>
    ${stat('vm-cpu', 'CPU')}
    ${stat('vm-mem', 'Memory')}
    ${stat('apps-cpu', 'Projects CPU')}
    ${stat('apps-mem', 'Projects memory')}
    ${updated}
    ${dockerError}
  </section>`;
}

/** A project's CPU and memory first, the whole VM's next to it, quieter. */
export function projectPanel(projectId: number): Html {
  return html`<section class="metrics" data-metrics="/api/projects/${projectId}/metrics" data-metrics-kind="project" aria-label="Resource usage" aria-busy="true">
    <div class="metrics-head"><h2 class="section-title">Resource usage</h2>${updated}</div>
    <div class="metrics-grid">
      <div class="metric-card metric-idle" data-idle hidden>
        <div class="metric-label">This project</div>
        <div class="metric-idle-text">Not running</div>
        <div class="metric-sub">No CPU or memory in use.</div>
      </div>
      ${tile('p-cpu', 'CPU', 'this project')}
      ${tile('p-mem', 'Memory', 'this project')}
      ${tile('vm-cpu', 'VM CPU', 'whole machine', true)}
      ${tile('vm-mem', 'VM memory', 'whole machine', true)}
    </div>
    ${dockerError}
  </section>`;
}

/** An empty table cell ui.js fills with a project's or container's usage. */
export function usageCell(attr: 'data-project' | 'data-ct', key: string, field: 'cpu' | 'mem' | 'net' | 'pids'): Html {
  return attr === 'data-project'
    ? html`<td class="cell-usage" data-project="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`
    : html`<td class="cell-usage" data-ct="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`;
}
