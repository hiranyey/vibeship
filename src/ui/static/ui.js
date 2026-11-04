// Vibeship's only client script: live logs over server-sent events,
// confirm prompts, copy buttons, busy buttons, status polling and the
// dashboard filter and the CPU and memory panels. No build step.
(() => {
  'use strict';

  /** Appends one log line to a `.log-body`, keeping it scrolled to the end if it was. */
  function appendLine(body, { seq, stream, line, ts }) {
    // Container logs come with Docker's timestamp in front of the line.
    const stamped = !ts && /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/s.exec(line);
    if (stamped) [, ts, line] = stamped;
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const row = document.createElement('div');
    row.className = 'log-line' + (ts ? '' : ' no-ts');
    const num = document.createElement('span');
    num.className = 'log-num';
    num.textContent = String(seq ?? body.childElementCount + 1);
    row.append(num);
    if (ts) {
      const t = document.createElement('span');
      t.className = 'log-ts';
      t.textContent = ts.slice(11, 19);
      row.append(t);
    }
    const text = document.createElement('span');
    // Same rule as lineClass() in src/ui/projects.ts.
    text.className = stream === 'system' && /^(Deploy failed|Could not|No earlier)/.test(line) ? 'log-err'
      : stream === 'system' && /is live$|serving again$/.test(line) ? 'log-ok' : 'log-out';
    text.textContent = line;
    row.append(text);
    body.append(row);
    if (atEnd) body.scrollTop = body.scrollHeight;
  }

  function setLive(viewer, text, live) {
    const badge = viewer.querySelector('[data-live]');
    if (!badge) return;
    badge.hidden = false;
    badge.lastChild.textContent = ' ' + text;
    badge.querySelector('.log-live-dot').hidden = !live;
  }

  // <div class="log-viewer" data-stream="/api/..." data-kind="deploy|container">
  for (const viewer of document.querySelectorAll('[data-stream]')) {
    const body = viewer.querySelector('.log-body');
    body.scrollTop = body.scrollHeight;
    const source = new EventSource(viewer.dataset.stream);
    setLive(viewer, 'connecting', true);
    source.addEventListener('open', () => setLive(viewer, 'streaming', true));
    source.addEventListener('log', (e) => appendLine(body, JSON.parse(e.data)));
    // A deploy finished: reload to show its final state.
    source.addEventListener('done', () => {
      source.close();
      setLive(viewer, 'finished', false);
      setTimeout(() => location.reload(), 600);
    });
    source.addEventListener('end', () => {
      source.close();
      setLive(viewer, 'stream ended', false);
    });
    source.addEventListener('error', (e) => {
      // A server-sent `error` event has data; a dropped connection doesn't.
      if (e.data) {
        source.close();
        setLive(viewer, JSON.parse(e.data).message, false);
      } else if (source.readyState === EventSource.CLOSED) {
        setLive(viewer, 'disconnected', false);
      } else {
        setLive(viewer, 'reconnecting', true);
      }
    });
  }

  // <form data-confirm="Really?">, then a busy state on the button that sent it,
  // so a slow deploy can't be posted twice.
  const BUSY = {
    Deploy: 'Deploying', Save: 'Saving', Create: 'Creating', Add: 'Adding', Delete: 'Deleting',
    Restart: 'Restarting', Stop: 'Stopping', Start: 'Starting', Revoke: 'Revoking', Remove: 'Removing', Rotate: 'Rotating',
  };
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const msg = form.dataset && form.dataset.confirm;
    if (msg && !confirm(msg)) {
      e.preventDefault();
      return;
    }
    if (e.defaultPrevented || form.method.toLowerCase() !== 'post') return;
    const btn = e.submitter || form.querySelector('[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.dataset.idleHtml = btn.innerHTML;
    btn.style.minWidth = btn.offsetWidth + 'px';
    const label = btn.textContent.trim();
    const verb = label.split(/\s+/)[0];
    const busy = BUSY[verb] ? BUSY[verb] + '…' : label;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    btn.append(document.createTextNode(busy));
    btn.classList.add('btn-loading', 'is-busy');
    btn.setAttribute('aria-busy', 'true');
    // Disabling inside the submit event still lets this submission go through.
    setTimeout(() => { btn.disabled = true; }, 0);
  });
  // Coming back with the browser's back button restores the page as it was left.
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const btn of document.querySelectorAll('[data-idle-html]')) {
      btn.innerHTML = btn.dataset.idleHtml;
      btn.disabled = false;
      btn.classList.remove('btn-loading', 'is-busy');
      btn.removeAttribute('aria-busy');
      btn.style.minWidth = '';
      delete btn.dataset.idleHtml;
    }
  });

  // <button data-copy-text="value"> or <button data-copy="element-id">
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-text], [data-copy]');
    if (!btn) return;
    const el = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : null;
    const text = btn.dataset.copyText ?? el?.textContent.trim() ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      return;
    }
    clearTimeout(btn._copyTimer);
    btn.classList.add('is-copied');
    if (btn.dataset.copy) {
      btn.dataset.idleText ??= btn.textContent;
      btn.textContent = 'Copied';
    }
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove('is-copied');
      if (btn.dataset.idleText) btn.textContent = btn.dataset.idleText;
    }, 1600);
  });

  // Success notices fade out on their own; errors stay until the next page.
  for (const el of document.querySelectorAll('[data-autodismiss]')) {
    let timer;
    const arm = () => { timer = setTimeout(leave, 5000); };
    const leave = () => {
      el.style.height = el.offsetHeight + 'px';
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
    arm();
  }

  // <span data-watch="/api/projects/1" data-watch-status="deploying">: reload
  // once the status moves on, so a deploy finishing shows without a refresh.
  const watched = [...document.querySelectorAll('[data-watch]')];
  if (watched.length > 0) {
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 30 * 60_000) return;
      if (!document.hidden) {
        for (const el of watched) {
          try {
            const res = await fetch(el.dataset.watch, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
            if (res.status === 401 || res.status === 403) return;
            if (res.ok && (await res.json()).status !== el.dataset.watchStatus) {
              location.reload();
              return;
            }
          } catch {
            // Offline for a moment; try again next round.
          }
        }
      }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 4000);
  }

  // Dashboard filter: a text box and status chips over rows with data-filter-row.
  for (const bar of document.querySelectorAll('[data-filter-for]')) {
    const table = document.getElementById(bar.dataset.filterFor);
    if (!table) continue;
    const search = bar.querySelector('[data-filter-search]');
    const chips = [...bar.querySelectorAll('[data-filter-status]')];
    const rows = [...table.querySelectorAll('[data-filter-row]')];
    const empty = table.querySelector('[data-filter-empty]');
    let status = 'all';
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const match = (status === 'all' || row.dataset.status === status) && (!q || row.dataset.name.toLowerCase().includes(q));
        row.hidden = !match;
        if (match) shown++;
      }
      if (empty) empty.hidden = shown > 0;
    };
    const pick = (st) => {
      status = st;
      for (const c of chips) {
        const on = c.dataset.filterStatus === st;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      }
      apply();
    };
    search.addEventListener('input', apply);
    for (const c of chips) c.addEventListener('click', () => pick(c.dataset.filterStatus));
    table.querySelector('[data-filter-reset]')?.addEventListener('click', () => {
      search.value = '';
      pick('all');
      search.focus();
    });
    // "/" jumps to the filter, as in many dashboards.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      search.focus();
    });
  }

  // <input data-confirm-name="hello"> keeps the form's [data-confirm-target] disabled until it matches.
  for (const input of document.querySelectorAll('[data-confirm-name]')) {
    const btn = input.form?.querySelector('[data-confirm-target]');
    if (!btn) continue;
    const sync = () => { btn.disabled = input.value.trim() !== input.dataset.confirmName; };
    input.addEventListener('input', sync);
    sync();
  }

  // ——— Resource panels: <section data-metrics="/api/…" data-metrics-kind="overview|project"> ———

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
  }
  const pct = (n) => (n < 10 ? n.toFixed(1) : Math.round(n)) + '%';
  const clamp = (n) => Math.max(0, Math.min(100, n || 0));

  /** Draws `values` into an svg[data-spark]; `max` null scales to the data. */
  function drawSpark(svg, values, max) {
    if (!svg) return;
    const [area, line] = svg.querySelectorAll('path');
    if (values.length < 2) { area.setAttribute('d', ''); line.setAttribute('d', ''); return; }
    const top = max ?? Math.max(1, ...values) * 1.25;
    const step = 100 / (values.length - 1);
    const pts = values.map((v, i) => [i * step, 31 - (Math.min(v, top) / top) * 29]);
    const d = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', d + ' L100 32 L0 32 Z');
  }

  function usageCellHtml(text, share, title) {
    const bar = share == null ? '' : '<span class="usage-bar"><i style="width:' + clamp(share) + '%"></i></span>';
    return '<span class="usage" title="' + (title || '') + '">' + text + bar + '</span>';
  }
  const idle = '<span class="text-subtle">—</span>';

  for (const panel of document.querySelectorAll('[data-metrics]')) {
    const kind = panel.dataset.metricsKind;
    const bind = (key, text) => { const el = panel.querySelector('[data-bind="' + key + '"]'); if (el) el.textContent = text; };
    const bar = (key, value) => { const el = panel.querySelector('[data-bar="' + key + '"]'); if (el) el.style.width = clamp(value) + '%'; };
    const spark = (key) => panel.querySelector('[data-spark="' + key + '"]');
    const errorBox = panel.querySelector('[data-bind-error]');
    const local = [];
    let timer = null;
    let failures = 0;

    const render = (data) => {
      const h = data.host;
      panel.setAttribute('aria-busy', 'false');
      panel.classList.add('is-ready');
      bind('updated', 'updated ' + new Date(h.at).toLocaleTimeString());
      errorBox.hidden = !data.dockerError;
      if (data.dockerError) bind('error', data.dockerError);

      if (kind === 'overview') {
        bind('cpu', pct(h.cpuPercent));
        bind('cpu-sub', h.cores + ' cores · load ' + h.load.join(' / '));
        bind('mem', fmtBytes(h.memUsedBytes));
        bind('mem-sub', 'of ' + fmtBytes(h.memTotalBytes) + ' · ' + pct(h.memPercent));
        bar('cpu-total', h.cpuPercent);
        bar('cpu-part', Math.min(data.apps.cpuShare, h.cpuPercent));
        bar('mem-total', h.memPercent);
        bar('mem-part', Math.min(data.apps.memShare, h.memPercent));
        // The server keeps a point every 15 s; points taken here fill the gap since the last one.
        local.push({ at: h.at, cpu: h.cpuPercent, mem: h.memPercent });
        const lastServer = data.history.at(-1)?.at ?? '';
        const series = [...data.history.map((p) => ({ cpu: p.cpuPercent, mem: p.memPercent })), ...local.filter((p) => p.at > lastServer)].slice(-240);
        drawSpark(spark('cpu'), series.map((p) => p.cpu), 100);
        drawSpark(spark('mem'), series.map((p) => p.mem), 100);
        const busiest = data.projects.slice(0, 3).map((p) => p.project + ' ' + pct(p.cpuShare)).join(', ');
        bind('note', data.projects.length === 0
          ? 'No project containers are running.'
          : 'Projects use ' + pct(data.apps.cpuShare) + ' of CPU and ' + fmtBytes(data.apps.memBytes) + ' of memory' + (busiest ? '. Busiest: ' + busiest + '.' : '.'));
        const byName = new Map(data.projects.map((p) => [p.project, p]));
        for (const td of document.querySelectorAll('td[data-project][data-usage]')) {
          const u = byName.get(td.dataset.project);
          td.innerHTML = !u ? idle : td.dataset.usage === 'cpu'
            ? usageCellHtml(pct(u.cpuShare), u.cpuShare, (u.cpuPercent / 100).toFixed(2) + ' cores')
            : usageCellHtml(fmtBytes(u.memBytes), u.memShare, pct(u.memShare) + ' of the VM');
        }
      } else {
        const u = data.usage;
        bind('cpu', pct(u.cpuShare));
        bind('cpu-sub', (u.cpuPercent / 100).toFixed(2) + ' of ' + h.cores + ' cores · VM at ' + pct(h.cpuPercent));
        bind('mem', fmtBytes(u.memBytes));
        bind('mem-sub', pct(u.memShare) + ' of ' + fmtBytes(h.memTotalBytes) + ' · VM at ' + pct(h.memPercent));
        bar('cpu-total', Math.max(h.cpuPercent, u.cpuShare));
        bar('cpu-part', u.cpuShare);
        bar('mem-total', Math.max(h.memPercent, u.memShare));
        bar('mem-part', u.memShare);
        local.push({ cpu: u.cpuShare, mem: u.memBytes });
        if (local.length > 120) local.shift();
        drawSpark(spark('cpu'), local.map((p) => p.cpu), null);
        drawSpark(spark('mem'), local.map((p) => p.mem), null);
        bind('note', u.containers === 0
          ? 'No running containers, so nothing to measure.'
          : u.containers + ' running container' + (u.containers === 1 ? '' : 's') + '. CPU is a share of all ' + h.cores + ' cores; the graphs cover the time this page has been open.');
        const byName = new Map(data.containers.map((c) => [c.name, c]));
        for (const td of document.querySelectorAll('td[data-ct][data-usage]')) {
          const c = byName.get(td.dataset.ct);
          const f = td.dataset.usage;
          td.innerHTML = !c ? idle
            : f === 'cpu' ? usageCellHtml(pct(c.cpuShare), c.cpuShare, (c.cpuPercent / 100).toFixed(2) + ' cores')
            : f === 'mem' ? usageCellHtml(fmtBytes(c.memBytes), c.memLimitBytes ? (c.memBytes / c.memLimitBytes) * 100 : null, 'limit ' + fmtBytes(c.memLimitBytes))
            : f === 'net' ? '<span class="usage">' + fmtBytes(c.netRxBytes) + ' / ' + fmtBytes(c.netTxBytes) + '</span>'
            : '<span class="usage">' + c.pids + '</span>';
        }
      }
    };

    const tick = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      try {
        const res = await fetch(panel.dataset.metrics, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
        if (res.status === 401 || res.status === 403) { bind('updated', 'signed out'); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        render(await res.json());
        failures = 0;
      } catch {
        failures++;
        bind('updated', 'could not refresh, retrying');
      }
      timer = setTimeout(tick, Math.min(5000 * 2 ** failures, 60_000));
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    tick();
  }
})();
