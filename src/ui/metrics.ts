import { html } from 'hono/html';
import type { Html } from './view.ts';

/**
 * Resource panels. They render with placeholders; ui.js fetches the numbers
 * (`docker stats` takes a second or two, so pages don't wait for it) and
 * refreshes them every few seconds. Elements are found by `data-bind`
 * (text), `data-bar` (width in %) and `data-spark` (a sparkline).
 */

const DASH = '—';

function meter(label: string, key: string, legend: [string, string]): Html {
  return html`<div class="meter" role="img" aria-label="${label}">
      <div class="meter-fill meter-total" data-bar="${key}-total"></div>
      <div class="meter-fill meter-part" data-bar="${key}-part"></div>
    </div>
    <div class="meter-legend"><span><i class="swatch-part"></i>${legend[0]}</span><span><i class="swatch-total"></i>${legend[1]}</span></div>`;
}

function spark(key: string): Html {
  return html`<svg class="spark" data-spark="${key}" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d=""></path><path class="spark-line" d=""></path></svg>`;
}

/** The VM's CPU and memory with the last hour, for the dashboard. */
export function hostPanel(): Html {
  return html`<section class="metrics" data-metrics="/api/metrics" data-metrics-kind="overview" aria-labelledby="metrics-title" aria-busy="true">
    <div class="metrics-head">
      <h2 class="section-title" id="metrics-title">Server</h2>
      <span class="metrics-updated"><span class="live-dot"></span><span data-bind="updated">loading…</span></span>
    </div>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-top">
          <div>
            <div class="stat-label">CPU</div>
            <div class="metric-value" data-bind="cpu">${DASH}</div>
            <div class="metric-sub" data-bind="cpu-sub">&nbsp;</div>
          </div>
          ${spark('cpu')}
        </div>
        ${meter('CPU in use', 'cpu', ['projects', 'everything else'])}
      </div>
      <div class="metric-card">
        <div class="metric-top">
          <div>
            <div class="stat-label">Memory</div>
            <div class="metric-value" data-bind="mem">${DASH}</div>
            <div class="metric-sub" data-bind="mem-sub">&nbsp;</div>
          </div>
          ${spark('mem')}
        </div>
        ${meter('Memory in use', 'mem', ['projects', 'everything else'])}
      </div>
    </div>
    <p class="metrics-note text-muted t-sm" data-bind="note">&nbsp;</p>
    <div class="alert alert-warning metrics-error" data-bind-error hidden><div><div class="alert-title">Docker did not answer</div><div class="alert-body" data-bind="error"></div></div></div>
  </section>`;
}

/** A project's CPU and memory against the VM, for its overview. */
export function projectPanel(projectId: number): Html {
  return html`<section class="metrics" data-metrics="/api/projects/${projectId}/metrics" data-metrics-kind="project" aria-labelledby="metrics-title" aria-busy="true">
    <div class="metrics-head">
      <h2 class="section-title" id="metrics-title">Resource usage</h2>
      <span class="metrics-updated"><span class="live-dot"></span><span data-bind="updated">loading…</span></span>
    </div>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-top">
          <div>
            <div class="stat-label">CPU</div>
            <div class="metric-value" data-bind="cpu">${DASH}</div>
            <div class="metric-sub" data-bind="cpu-sub">&nbsp;</div>
          </div>
          ${spark('cpu')}
        </div>
        ${meter('CPU: this project against the whole VM', 'cpu', ['this project', 'rest of the VM'])}
      </div>
      <div class="metric-card">
        <div class="metric-top">
          <div>
            <div class="stat-label">Memory</div>
            <div class="metric-value" data-bind="mem">${DASH}</div>
            <div class="metric-sub" data-bind="mem-sub">&nbsp;</div>
          </div>
          ${spark('mem')}
        </div>
        ${meter('Memory: this project against the whole VM', 'mem', ['this project', 'rest of the VM'])}
      </div>
    </div>
    <p class="metrics-note text-muted t-sm" data-bind="note">&nbsp;</p>
    <div class="alert alert-warning metrics-error" data-bind-error hidden><div><div class="alert-title">Docker did not answer</div><div class="alert-body" data-bind="error"></div></div></div>
  </section>`;
}

/** An empty table cell ui.js fills with a project's or container's usage. */
export function usageCell(attr: 'data-project' | 'data-ct', key: string, field: 'cpu' | 'mem' | 'net' | 'pids'): Html {
  return attr === 'data-project'
    ? html`<td class="cell-usage" data-project="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`
    : html`<td class="cell-usage" data-ct="${key}" data-usage="${field}"><span class="text-subtle">${DASH}</span></td>`;
}
