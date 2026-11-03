// Vibeship's only client script: live logs over server-sent events,
// confirm prompts and copy buttons. No build step.
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

  // <form data-confirm="Really?">
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset && e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // <button data-copy="element-id">
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const el = document.getElementById(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(el.textContent.trim());
      btn.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
})();
