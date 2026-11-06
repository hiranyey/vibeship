// Vibeship's only client script: live logs over server-sent events,
// confirm prompts, copy buttons, busy buttons, status polling and the
// dashboard filter and the CPU and memory cards. No build step.
(() => {
  'use strict';

  // On phones, tables turn into stacked cards (see `.table.is-stackable` in
  // vibeship.css). Each cell is labelled with its column heading here; cells
  // only ever get new contents later, so the labels stay put.
  for (const table of document.querySelectorAll('table.table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const row of table.tBodies[0]?.rows ?? []) {
      [...row.cells].forEach((td, i) => {
        if (heads[i] && td.colSpan === 1) td.dataset.label = heads[i];
      });
    }
    table.classList.add('is-stackable');
  }

  // Project tabs scroll sideways on phones; keep the current one in view.
  const tabList = document.querySelector('.tab-list');
  const currentTab = tabList?.querySelector('[aria-current="page"]');
  if (tabList && currentTab && tabList.scrollWidth > tabList.clientWidth) {
    tabList.scrollLeft = currentTab.offsetLeft - tabList.offsetLeft - (tabList.clientWidth - currentTab.offsetWidth) / 2;
  }

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

  // ——— CPU and memory cards: <section data-metrics="/api/…" data-metrics-kind="overview|project"> ———

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return ['0', 'B'];
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return [String(n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)), units[i]];
  }
  const bytes = (n) => fmtBytes(n).join(' ');
  const num = (n) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
  const clamp = (n) => Math.max(0, Math.min(100, n || 0));

  function usageCellHtml(text, share, title) {
    const bar = share == null ? '' : '<span class="usage-bar"><i style="width:' + clamp(share) + '%"></i></span>';
    return '<span class="usage" title="' + (title || '') + '">' + text + bar + '</span>';
  }
  const idle = '<span class="text-subtle">—</span>';

  for (const panel of document.querySelectorAll('[data-metrics]')) {
    const kind = panel.dataset.metricsKind;
    const bind = (key, text) => { const el = panel.querySelector('[data-bind="' + key + '"]'); if (el) el.textContent = text; };
    const errorBox = panel.querySelector('[data-bind-error]');
    let timer = null;
    let failures = 0;

    /** Fills one card: value + unit, a detail line, and a meter that warns past 75% and 90%. */
    const tile = (key, value, unit, sub, meter) => {
      bind(key, value);
      bind(key + '-unit', unit);
      bind(key + '-sub', sub);
      const bar = panel.querySelector('[data-bar="' + key + '"]');
      if (bar) {
        bar.style.width = clamp(meter) + '%';
        bar.dataset.level = meter >= 90 ? 'high' : meter >= 75 ? 'warn' : 'ok';
      }
    };

    const render = (data) => {
      const h = data.host;
      panel.setAttribute('aria-busy', 'false');
      panel.classList.add('is-ready');
      bind('updated', 'updated ' + new Date(h.at).toLocaleTimeString());
      errorBox.hidden = !data.dockerError;
      if (data.dockerError) bind('error', data.dockerError);

      const [memUsed, memUnit] = fmtBytes(h.memUsedBytes);
      tile('vm-cpu', num(h.cpuPercent), '%', h.cores + ' cores · load ' + h.load[0], h.cpuPercent);
      tile('vm-mem', memUsed, memUnit, 'of ' + bytes(h.memTotalBytes) + ' · ' + num(h.memPercent) + '% used', h.memPercent);

      if (kind === 'overview') {
        const a = data.apps;
        const [appsMem, appsUnit] = fmtBytes(a.memBytes);
        const n = data.projects.length;
        tile('apps-cpu', num(a.cpuShare), '%', n === 0 ? 'nothing running' : n + ' running project' + (n === 1 ? '' : 's'), a.cpuShare);
        tile('apps-mem', appsMem, appsUnit, num(a.memShare) + '% of the VM', a.memShare);
        const byName = new Map(data.projects.map((p) => [p.project, p]));
        for (const td of document.querySelectorAll('td[data-project][data-usage]')) {
          const u = byName.get(td.dataset.project);
          td.innerHTML = !u ? idle : td.dataset.usage === 'cpu'
            ? usageCellHtml(num(u.cpuShare) + '%', u.cpuShare, (u.cpuPercent / 100).toFixed(2) + ' cores')
            : usageCellHtml(bytes(u.memBytes), u.memShare, num(u.memShare) + '% of the VM');
        }
      } else {
        const u = data.usage;
        const [pMem, pUnit] = fmtBytes(u.memBytes);
        const running = u.containers > 0;
        // Not running: one quiet card instead of two cards of dashes.
        const idleCard = panel.querySelector('[data-idle]');
        if (idleCard) idleCard.hidden = running;
        for (const key of ['p-cpu', 'p-mem']) {
          const card = panel.querySelector('[data-tile="' + key + '"]');
          if (card) card.hidden = !running;
        }
        tile('p-cpu', running ? num(u.cpuShare) : '—', running ? '%' : '', running ? (u.cpuPercent / 100).toFixed(2) + ' of ' + h.cores + ' cores' : 'not running', u.cpuShare);
        tile('p-mem', running ? pMem : '—', running ? pUnit : '', running ? num(u.memShare) + '% of the VM' : 'not running', u.memShare);
        const byName = new Map(data.containers.map((c) => [c.name, c]));
        for (const td of document.querySelectorAll('td[data-ct][data-usage]')) {
          const c = byName.get(td.dataset.ct);
          const f = td.dataset.usage;
          td.innerHTML = !c ? idle
            : f === 'cpu' ? usageCellHtml(num(c.cpuShare) + '%', c.cpuShare, (c.cpuPercent / 100).toFixed(2) + ' cores')
            : f === 'mem' ? usageCellHtml(bytes(c.memBytes), c.memLimitBytes ? (c.memBytes / c.memLimitBytes) * 100 : null, 'limit ' + bytes(c.memLimitBytes))
            : f === 'net' ? '<span class="usage">' + bytes(c.netRxBytes) + ' / ' + bytes(c.netTxBytes) + '</span>'
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
