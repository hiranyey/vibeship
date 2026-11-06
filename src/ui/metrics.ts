import { html } from 'hono/html';
import type { Html } from './components.ts';

/**
 * CPU and memory. They render with placeholders; ui.js fetches the latest
 * numbers (`docker stats` takes a second or two, so pages don't wait for it)
 * and refreshes them every few seconds. ui.js finds the parts by
 * `data-bind` (text) and `data-bar` (meter width in %).
 */

const DASH = '—';

/** "Live · updated 14:03:22 UTC"; ui.js fills it with the same format as every other time. */
const updated = html`<span class="metrics-updated"><span class="live-dot" aria-hidden="true"></span><span data-bind="updated">loading…</span></span>`;
const dockerError = html`<div class="alert alert-warning" data-bind-error hidden><div><div class="alert-title">Docker did not answer</div><div class="alert-body" data-bind="error"></div></div></div>`;

/** One cell: a label (and an optional badge), a big number, a line of detail and a meter. */
function tile(key: string, label: string, hint: string, badge?: Html): Html {
  return html`<div class="metric-card" data-tile="${key}">
    <div class="metric-head"><span class="metric-label">${label}</span>${badge ?? ''}</div>
    <div class="metric-value"><span data-bind="${key}">${DASH}</span><span class="metric-unit" data-bind="${key}-unit"></span></div>
    <div class="metric-sub" data-bind="${key}-sub">${hint}</div>
    <div class="meter" aria-hidden="true"><div class="meter-fill" data-bar="${key}"></div></div>
  </div>`;
}

/** A card with a label strip on top and cells below. */
function panel(url: string, kind: 'overview' | 'project', title: string, cells: Html, wide = false): Html {
  const id = `metrics-${kind}`;
  return html`<section class="card metrics" data-metrics="${url}" data-metrics-kind="${kind}" aria-labelledby="${id}" aria-busy="true">
    <div class="card-strip"><h2 class="label" id="${id}">${title}</h2>${updated}</div>
    <div class="metric-cells${wide ? ' is-wide' : ''}">${cells}</div>
    ${dockerError}
  </section>`;
}

/** The VM, and what all projects use of it: the dashboard's Server card. */
export function hostPanel(): Html {
  return panel('/api/metrics', 'overview', 'Server', html`
    ${tile('vm-cpu', 'CPU', 'of the VM')}
    ${tile('vm-mem', 'Memory', 'of the VM')}
    ${tile('apps-cpu', 'Projects CPU', 'all projects together')}
    ${tile('apps-mem', 'Projects memory', 'all projects together')}`);
}

/**
 * A project's CPU and memory, then the host VM in one quieter cell.
 * `memWarning` is a badge for the Memory cell, e.g. "No limit".
 */
export function projectPanel(projectId: number, memWarning?: Html): Html {
  return panel(`/api/projects/${projectId}/metrics`, 'project', 'Resource usage', html`
    <div class="metric-card" data-idle hidden>
      <div class="metric-label">This project</div>
      <div class="metric-idle-text">Not running</div>
      <div class="metric-sub">No CPU or memory in use.</div>
    </div>
    ${tile('p-cpu', 'CPU', 'this project')}
    ${tile('p-mem', 'Memory', 'this project', memWarning)}
    <div class="metric-card is-secondary">
      <div class="metric-label">Host VM</div>
      <div class="metric-line"><span>CPU</span><span class="mono" data-bind="vm-cpu-line">${DASH}</span></div>
      <div class="metric-line"><span>Memory</span><span class="mono" data-bind="vm-mem-line">${DASH}</span></div>
      <div class="meter" aria-hidden="true"><div class="meter-fill" data-bar="vm-mem"></div></div>
    </div>`, true);
}

/** An empty table cell ui.js fills with a project's or container's usage. */
export function usageCell(attr: 'data-project' | 'data-ct', key: string, field: 'cpu' | 'mem' | 'net' | 'pids'): Html {
  return attr === 'data-project'
    ? html`<td class="cell-usage" data-project="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`
    : html`<td class="cell-usage" data-ct="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`;
}
