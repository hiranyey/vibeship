import { html } from 'hono/html';
import type { Html } from './view.ts';

/**
 * CPU and memory cards. They render with placeholders; ui.js fetches the
 * latest numbers (`docker stats` takes a second or two, so pages don't wait
 * for it) and refreshes them every few seconds. ui.js finds the parts by
 * `data-bind` (text) and `data-bar` (meter width in %).
 */

const DASH = '—';

/** One card: a label, a big number, a line of detail and a meter. */
function tile(key: string, label: string, hint: string): Html {
  return html`<div class="metric-card" data-tile="${key}">
    <div class="metric-label">${label}</div>
    <div class="metric-value"><span data-bind="${key}">${DASH}</span><span class="metric-unit" data-bind="${key}-unit"></span></div>
    <div class="metric-sub" data-bind="${key}-sub">${hint}</div>
    <div class="meter" aria-hidden="true"><div class="meter-fill" data-bar="${key}"></div></div>
  </div>`;
}

function panel(url: string, kind: 'overview' | 'project', title: string, tiles: Html): Html {
  return html`<section class="metrics" data-metrics="${url}" data-metrics-kind="${kind}" aria-label="${title}" aria-busy="true">
    <div class="metrics-head">
      <h2 class="section-title">${title}</h2>
      <span class="metrics-updated"><span class="live-dot"></span><span data-bind="updated">loading…</span></span>
    </div>
    <div class="metrics-grid">${tiles}</div>
    <div class="alert alert-warning" data-bind-error hidden><div><div class="alert-title">Docker did not answer</div><div class="alert-body" data-bind="error"></div></div></div>
  </section>`;
}

/** The VM's CPU and memory, and what all projects use of them, for the dashboard. */
export function hostPanel(): Html {
  return panel('/api/metrics', 'overview', 'Server', html`
    ${tile('vm-cpu', 'CPU', 'of the VM')}
    ${tile('vm-mem', 'Memory', 'of the VM')}
    ${tile('apps-cpu', 'Projects CPU', 'all projects together')}
    ${tile('apps-mem', 'Projects memory', 'all projects together')}`);
}

/** A project's CPU and memory next to the VM's, for its overview. */
export function projectPanel(projectId: number): Html {
  return panel(`/api/projects/${projectId}/metrics`, 'project', 'Resource usage', html`
    <div class="metric-card metric-idle" data-idle hidden>
      <div class="metric-label">This project</div>
      <div class="metric-idle-text">Not running</div>
      <div class="metric-sub">No CPU or memory in use.</div>
    </div>
    ${tile('p-cpu', 'CPU', 'this project')}
    ${tile('p-mem', 'Memory', 'this project')}
    ${tile('vm-cpu', 'VM CPU', 'whole machine')}
    ${tile('vm-mem', 'VM memory', 'whole machine')}`);
}

/** An empty table cell ui.js fills with a project's or container's usage. */
export function usageCell(attr: 'data-project' | 'data-ct', key: string, field: 'cpu' | 'mem' | 'net' | 'pids'): Html {
  return attr === 'data-project'
    ? html`<td class="cell-usage" data-project="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`
    : html`<td class="cell-usage" data-ct="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`;
}
