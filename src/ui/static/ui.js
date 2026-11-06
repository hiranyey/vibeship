// Vibeship's only client script: live logs over server-sent events, the
// confirm dialog, drawers, inline form validation, copy buttons, busy
// buttons, status polling, the dashboard filter and the CPU and memory
// numbers. No build step. Everything works without it except live updates;
// forms then fall back to the server's own validation.
(() => {
  'use strict';

  /** "2026-11-06 14:03:22 UTC": the same format as absoluteTime() in src/ui/components.ts. */
  const fmtAbs = (t) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

  const live = document.getElementById('live-region');
  /** Tells screen readers about something that happened without a page load. */
  const announce = (text) => {
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  };

  // On phones, tables turn into stacked cards (see `.table.is-stackable` in
  // vibeship.css). Each cell is labelled with its column heading here; cells
  // only ever get new contents later, so the labels stay put.
  for (const table of document.querySelectorAll('table.table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const body of table.tBodies) {
      for (const row of body.rows) {
        [...row.cells].forEach((td, i) => {
          if (heads[i] && td.colSpan === 1) td.dataset.label = heads[i];
        });
      }
    }
    table.classList.add('is-stackable');
  }

  // Project tabs scroll sideways on phones; keep the current one in view.
  const tabList = document.querySelector('.tab-list');
  const currentTab = tabList?.querySelector('[aria-current="page"]');
  if (tabList && currentTab && tabList.scrollWidth > tabList.clientWidth) {
    tabList.scrollLeft = currentTab.offsetLeft - tabList.offsetLeft - (tabList.clientWidth - currentTab.offsetWidth) / 2;
  }

  // ——— Live logs ———

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
      t.title = fmtAbs(ts);
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

  function setLive(viewer, text, on) {
    const badge = viewer.querySelector('[data-live]');
    if (!badge) return;
    badge.hidden = false;
    badge.lastChild.textContent = ' ' + text;
    badge.querySelector('.log-live-dot').hidden = !on;
  }

  // <div class="log-viewer" data-stream="/api/...">
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

  // ——— Inline validation for <form novalidate> ———

  const labelOf = (el) => {
    const label = el.id && document.querySelector('label[for="' + el.id + '"]');
    return (label?.textContent || el.name || 'This field').trim();
  };
  function messageFor(el) {
    const v = el.validity;
    const label = labelOf(el);
    if (v.valueMissing) return el.type === 'radio' ? 'Pick one.' : label + ' is required.';
    if (v.badInput) return 'Enter a number.';
    if (v.typeMismatch) return 'Enter a valid ' + label.toLowerCase() + '.';
    if (v.rangeUnderflow || v.rangeOverflow) {
      return el.min && el.max ? 'Use a number from ' + el.min + ' to ' + el.max + '.' : v.rangeUnderflow ? 'Use ' + el.min + ' or more.' : 'Use ' + el.max + ' or less.';
    }
    if (v.stepMismatch) return 'Use a whole number.';
    if (v.patternMismatch) return el.dataset.patternMessage || el.title || 'Check the format.';
    if (v.tooLong) return 'Use at most ' + el.maxLength + ' characters.';
    return el.validationMessage;
  }
  function showError(el, text) {
    const box = el.id && document.getElementById(el.id + '-error');
    if (text) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
    if (box) {
      box.textContent = text || '';
      box.hidden = !text;
    }
  }
  /** True when the form may be sent; otherwise shows each problem under its field and focuses the first. */
  function validate(form) {
    let first = null;
    for (const el of form.elements) {
      if (!el.willValidate) continue;
      const ok = el.checkValidity();
      showError(el, ok ? '' : messageFor(el));
      if (!ok && !first) first = el;
    }
    if (first) {
      first.focus();
      announce(messageFor(first));
    }
    return !first;
  }
  // Clear a field's error as soon as it is fixed.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.getAttribute?.('aria-invalid') === 'true' && el.checkValidity()) showError(el, '');
  });

  // ——— ConfirmDialog: <form data-confirm="body" data-confirm-title data-confirm-action data-confirm-tone> ———

  const dialog = document.getElementById('confirm-dialog');
  function askFirst(form, submitter) {
    const d = form.dataset;
    if (!dialog || typeof dialog.showModal !== 'function') {
      // No dialog on this page: fall back to the browser's own prompt.
      if (confirm(d.confirm)) {
        form.dataset.confirmed = '1';
        form.requestSubmit(submitter);
      }
      return;
    }
    dialog.querySelector('#confirm-title').textContent = d.confirmTitle || 'Are you sure?';
    dialog.querySelector('#confirm-body').textContent = d.confirm;
    const ok = dialog.querySelector('#confirm-ok');
    ok.textContent = d.confirmAction || 'Confirm';
    ok.className = 'btn ' + (d.confirmTone === 'danger' ? 'btn-danger' : 'btn-primary');
    dialog.returnValue = '';
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'confirm') return;
      form.dataset.confirmed = '1';
      form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
    }, { once: true });
    dialog.showModal();
  }

  // One submit handler, in order: validate, confirm, then a busy state on the
  // button that sent it, so a slow deploy can't be posted twice.
  const BUSY = {
    Deploy: 'Deploying', Save: 'Saving', Create: 'Creating', Add: 'Adding', Delete: 'Deleting',
    Restart: 'Restarting', Stop: 'Stopping', Start: 'Starting', Revoke: 'Revoking', Remove: 'Removing', Rotate: 'Rotating',
  };
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.method?.toLowerCase() === 'dialog') return;
    if (form.noValidate && !validate(form)) {
      e.preventDefault();
      return;
    }
    if (form.dataset.confirm && form.dataset.confirmed !== '1') {
      e.preventDefault();
      askFirst(form, e.submitter);
      return;
    }
    delete form.dataset.confirmed;
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
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    // The button's name/value must still be sent (e.g. "Save & deploy"), so
    // it is disabled only after the submission has been captured.
    setTimeout(() => { btn.disabled = true; }, 0);
  });
  // Coming back with the browser's back button restores the page as it was left.
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const btn of document.querySelectorAll('[data-idle-html]')) {
      btn.innerHTML = btn.dataset.idleHtml;
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.style.minWidth = '';
      delete btn.dataset.idleHtml;
    }
  });

  // ——— Drawers: <a data-drawer-open="id" href="fallback"> opens <dialog class="drawer" id="id"> ———

  function openDrawer(d) {
    if (d.open) d.close();
    d.showModal();
    d.querySelector('.drawer-body input:not([type="hidden"]), .drawer-body textarea, .drawer-body select')?.focus();
  }
  for (const d of document.querySelectorAll('dialog.drawer')) {
    // Rendered open: a direct link, or a form that came back with an error.
    if (d.hasAttribute('data-autoopen')) {
      openDrawer(d);
      d.querySelector('[aria-invalid="true"]')?.focus();
    }
    d.addEventListener('close', () => {
      // Leave /projects/new or ?new=… once the drawer is closed.
      const back = d.querySelector('[data-drawer-close]')?.getAttribute('href');
      if (back && location.pathname + location.search !== back) history.replaceState(null, '', back);
    });
    // A click on the backdrop closes it.
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-drawer-open]');
    if (opener) {
      const d = document.getElementById(opener.dataset.drawerOpen);
      if (d && typeof d.showModal === 'function') {
        e.preventDefault();
        openDrawer(d);
      }
      return;
    }
    const closer = e.target.closest('[data-drawer-close]');
    if (closer) {
      e.preventDefault();
      closer.closest('dialog').close();
    }
  });

  // Segmented control: <a data-kind-switch="image"> shows [data-kind-panel="image"].
  for (const link of document.querySelectorAll('[data-kind-switch]')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = link.dataset.kindSwitch;
      for (const l of document.querySelectorAll('[data-kind-switch]')) l.setAttribute('aria-current', String(l === link));
      for (const p of document.querySelectorAll('[data-kind-panel]')) p.hidden = p.dataset.kindPanel !== kind;
      document.querySelector('[data-kind-panel="' + kind + '"] input:not([type="hidden"])')?.focus();
    });
  }

  // <form data-autosubmit>: a filter form that applies as soon as a choice changes.
  for (const form of document.querySelectorAll('form[data-autosubmit]')) {
    form.addEventListener('change', (e) => {
      if (e.target.matches('select, input[type="checkbox"], input[type="date"]')) form.requestSubmit();
    });
  }

  // A link to a row inside a collapsed section (a revoked token) opens the section.
  const target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  const closed = target?.closest('details:not([open])');
  if (closed) {
    closed.open = true;
    target.scrollIntoView({ block: 'center' });
  }

  // ——— Copy: <button data-copy-text="value"> or <button data-copy="element-id"> ———

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
    announce('Copied');
    clearTimeout(btn._copyTimer);
    btn.classList.add('is-copied');
    // A button with a text label or a tooltip says "Copied" there too.
    const tip = btn.parentElement?.querySelector(':scope > .tooltip');
    if (tip) {
      tip.dataset.idleText ??= tip.textContent;
      tip.textContent = 'Copied';
    }
    if (btn.dataset.copy) {
      btn.dataset.idleText ??= btn.textContent;
      btn.textContent = 'Copied';
    }
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove('is-copied');
      if (btn.dataset.idleText) btn.textContent = btn.dataset.idleText;
      if (tip?.dataset.idleText) tip.textContent = tip.dataset.idleText;
    }, 1600);
  });

  // ——— Show/hide a secret: <button data-reveal="input-id" aria-pressed> ———

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reveal]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.reveal);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', btn.getAttribute('aria-label').replace(/^(Show|Hide)/, show ? 'Hide' : 'Show'));
  });

  // ——— Expiry presets: <button data-expiry-days="30" data-expiry-for="input-id"> ———

  for (const btn of document.querySelectorAll('[data-expiry-days]')) {
    const input = document.getElementById(btn.dataset.expiryFor);
    if (!input) continue;
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.expiryDays);
      input.value = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) : '';
      for (const b of document.querySelectorAll('[data-expiry-for="' + input.id + '"]')) b.setAttribute('aria-pressed', String(b === btn));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('change', () => {
      for (const b of document.querySelectorAll('[data-expiry-for="' + input.id + '"]')) b.setAttribute('aria-pressed', 'false');
    });
  }

  // ——— Sidebar labels, remembered in a cookie so the next page renders the same ———

  const shell = document.querySelector('.app-shell');
  document.querySelector('[data-sidebar-toggle]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const expanded = shell.classList.toggle('sidebar-expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.setAttribute('aria-label', expanded ? 'Hide labels' : 'Show labels');
    const tip = btn.parentElement.querySelector('.tooltip');
    if (tip) tip.textContent = expanded ? 'Hide labels' : 'Show labels';
    document.cookie = 'vs_sidebar=' + (expanded ? 'expanded' : 'collapsed') + '; path=/; max-age=31536000; samesite=lax';
  });

  // ——— User menu (details/summary): close on a click outside or Escape ———

  const menu = document.querySelector('.user-menu');
  if (menu) {
    document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
  }

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
  // Exactly one chip is selected (aria-pressed), and only it is highlighted.
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
      for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.filterStatus === st));
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

  // ——— CPU and memory: <section data-metrics="/api/…" data-metrics-kind="overview|project"> ———

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
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const usageHtml = (text, title) => '<span class="usage"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  const idle = '<span class="text-subtle">—</span>';

  for (const panel of document.querySelectorAll('[data-metrics]')) {
    const kind = panel.dataset.metricsKind;
    const bind = (key, text) => { for (const el of panel.querySelectorAll('[data-bind="' + key + '"]')) el.textContent = text; };
    const errorBox = panel.querySelector('[data-bind-error]');
    let timer = null;
    let failures = 0;

    /** Fills one figure: value + unit, a detail line, and a meter that warns past 75% and 90%. */
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
      const updated = panel.querySelector('[data-bind="updated"]');
      if (updated) {
        updated.textContent = 'updated ' + fmtAbs(h.at).slice(11);
        updated.title = fmtAbs(h.at);
      }
      errorBox.hidden = !data.dockerError;
      if (data.dockerError) bind('error', data.dockerError);

      const [memUsed, memUnit] = fmtBytes(h.memUsedBytes);
      tile('vm-cpu', num(h.cpuPercent), '%', h.cores + ' cores · load ' + h.load[0], h.cpuPercent);
      tile('vm-mem', memUsed, memUnit, 'of ' + bytes(h.memTotalBytes) + ' · ' + num(h.memPercent) + '% used', h.memPercent);

      if (kind === 'overview') {
        const a = data.apps;
        const [appsMem, appsUnit] = fmtBytes(a.memBytes);
        const n = data.projects.length;
        tile('apps-cpu', num(a.cpuShare), '%', n === 0 ? 'nothing running' : n + ' running', a.cpuShare);
        tile('apps-mem', appsMem, appsUnit, num(a.memShare) + '% of the VM', a.memShare);
        const byName = new Map(data.projects.map((p) => [p.project, p]));
        for (const td of document.querySelectorAll('td[data-project][data-usage]')) {
          const u = byName.get(td.dataset.project);
          td.innerHTML = !u ? idle : td.dataset.usage === 'cpu'
            ? usageHtml(num(u.cpuShare) + '%', (u.cpuPercent / 100).toFixed(2) + ' cores')
            : usageHtml(bytes(u.memBytes), num(u.memShare) + '% of the VM');
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
            : f === 'cpu' ? usageHtml(num(c.cpuShare) + '%', (c.cpuPercent / 100).toFixed(2) + ' cores')
            : f === 'mem' ? usageHtml(bytes(c.memBytes), c.memLimitBytes ? 'limit ' + bytes(c.memLimitBytes) : 'no limit')
            : f === 'net' ? usageHtml(bytes(c.netRxBytes) + ' / ' + bytes(c.netTxBytes))
            : usageHtml(String(c.pids));
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
