'use strict';
/* =========================================================================
   Slack Copilot — chat panel. Owns the #chat pane; nothing else in the app
   renders inside it. Spec: docs/ux.md §6. Server: src/chat.ts.

   HOW IT ATTACHES
   index.html ships an inert chat shell (openChat / closeChat / renderChat as
   plain globals). This file replaces those three globals with the real thing,
   so every existing call site — the "Discuss with Claude" buttons, the
   "Draft this reply →" button, the `c` shortcut, `esc`, and the 5s render
   loop — drives this panel without index.html having to change. If the page
   ever stops exposing apiFetch as a global (e.g. the inline script becomes a
   module) we bail out loudly instead of silently half-working.

   SECURITY (do not regress):
   1. Every /api call goes through the page's apiFetch(), which attaches the
      per-run x-copilot-token. There is not a single bare fetch() to /api here.
   2. Model output, draft text and Slack strings are all attacker-influenced.
      This file NEVER assigns innerHTML. Text reaches the DOM only through
      textContent / createTextNode, so `<img src=x onerror=...>` renders as
      characters. Only /^https?:\/\//i URLs become links, always with
      rel="noopener noreferrer".
   3. Sending to Slack happens in exactly one function (sendDraft), fired by a
      button click or ⌘enter inside that draft's own textarea. There is no
      global send key, nothing auto-sends, and the bytes posted are the ones
      in the textarea the user is looking at.
   ========================================================================= */

(function () {
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;

  /* --------------------------- host integration -------------------------- */

  const hostFetch = typeof window.apiFetch === 'function' ? window.apiFetch : null;

  /**
   * index.html's page state.
   *
   * NOT window.state: it is declared with `const`, and a top-level const in a classic
   * script lands in the global *lexical* environment, which is shared between scripts but
   * never exposed on window. So we reach it by bare identifier, guarded by typeof so this
   * file still runs (against its own scratch state) if index.html ever renames it.
   */
  const ownState = { items: [], cursor: null, chatOpen: false, focusPane: 'feed' };
  function S() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof state === 'object' && state !== null) return state;
    } catch (_) {
      /* not declared on this page */
    }
    return ownState;
  }
  function call(name, a, b) {
    const fn = window[name];
    if (typeof fn === 'function') return fn(a, b);
    return undefined;
  }
  function itemById(id) {
    const items = S().items;
    if (!Array.isArray(items)) return null;
    return items.find((i) => i.id === id) || null;
  }

  /* ------------------------------ dom helpers ---------------------------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function httpUrlOrNull(u) {
    const s = String(u == null ? '' : u);
    return /^https?:\/\//i.test(s) ? s : null;
  }
  function link(url, label) {
    const safe = httpUrlOrNull(url);
    if (!safe) return el('span', null, label);
    const a = document.createElement('a');
    a.href = safe;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  }
  function clockNow() {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /* ------------------------------ transport ------------------------------ */

  function apiFetch(path, options) {
    if (!hostFetch) return Promise.reject(new Error('chat is not attached to the page'));
    return hostFetch(path, options);
  }
  function onAuthFailure() {
    if (typeof window.handleAuthFailure === 'function') window.handleAuthFailure();
  }
  async function apiJson(path, options) {
    const res = await apiFetch(path, options);
    if (res.status === 401) {
      onAuthFailure();
      throw new Error('unauthorized');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const msg = data && (data.message || data.error);
      throw new Error(msg ? String(msg) : 'HTTP ' + res.status);
    }
    return data;
  }

  /* ------------------------------ chat state ----------------------------- */

  /** thread id -> conversation. Kept in memory; the server owns the durable copy. */
  const convos = new Map();

  function convo(id) {
    let c = convos.get(id);
    if (!c) {
      c = {
        id: id,
        loaded: false,
        loading: false,
        loadError: null,
        destination: null,
        sessionId: null,
        messages: [],
        composer: '',
        lastUserText: '',
        streaming: false,
        streamRaw: '',
        abort: null,
        failure: null, // last turn failure {kind,message,hint,detail}
      };
      convos.set(id, c);
    }
    return c;
  }

  /* ------------------------------ the panel ------------------------------ */

  /** Built once per thread; message nodes are appended, never wholesale rebuilt,
   *  so a focused composer or draft textarea is never yanked out from under you. */
  let panel = null;

  function teardownPanel() {
    panel = null;
    chatEl.replaceChildren();
  }

  function buildPanel(id) {
    const c = convo(id);
    const item = itemById(id);

    const head = el('div', 'chead');
    const who = el('span', 'who', 'Claude — ' + destLabel(c, item));
    head.appendChild(who);
    const sess = el('span', 'sess');
    const dot = el('i');
    const sessText = el('span', null, 'no session');
    sess.appendChild(dot);
    sess.appendChild(sessText);
    head.appendChild(sess);
    const x = el('button', 'cclose', '×');
    x.title = 'close (esc)';
    x.addEventListener('click', closeChat);
    head.appendChild(x);

    const body = el('div', 'cbody');
    body.addEventListener('scroll', () => {
      const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
      panel.pinned = gap < 60;
    });

    const comp = el('div', 'composer');
    const ta = el('textarea');
    ta.id = 'composer';
    ta.placeholder = 'Message Claude about this thread…';
    ta.value = c.composer || '';
    ta.addEventListener('input', () => {
      c.composer = ta.value;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        submitComposer();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeChat();
      }
    });
    comp.appendChild(ta);

    const row = el('div', 'crow');
    const send = el('button', 'csend', 'Send');
    send.addEventListener('click', submitComposer);
    row.appendChild(send);
    const stop = el('button', 'cstop', 'Stop');
    stop.title = 'stop this reply';
    stop.style.display = 'none';
    stop.addEventListener('click', () => stopTurn(c));
    row.appendChild(stop);
    row.appendChild(el('span', 'chint', 'enter to send · shift+enter newline'));
    comp.appendChild(row);

    chatEl.replaceChildren(head, body, comp);
    panel = {
      threadId: id,
      who: who,
      dot: dot,
      sessText: sessText,
      body: body,
      ta: ta,
      send: send,
      stop: stop,
      pinned: true,
      streamNode: null,
      streamBubble: null,
    };

    renderHistory(c);
    syncHead();
    // Always re-read from the server on open: the durable transcript lives there, so a
    // send, an app restart or a second window are all reflected. Skipped mid-turn, which
    // is the one moment the in-memory view is ahead of the database.
    if (!c.streaming && !c.loading) void loadHistory(c);
  }

  function destLabel(c, item) {
    if (c.destination && c.destination.label) return c.destination.label;
    if (item) {
      if (item.kind === 'mention') return '#' + (item.channel_name || 'channel');
      return item.channel_name ? 'DM · ' + item.channel_name : 'DM';
    }
    return 'this thread';
  }

  /** Head chip + composer affordances; cheap, safe to call on every poll. */
  function syncHead() {
    if (!panel) return;
    const c = convo(panel.threadId);
    panel.who.textContent = 'Claude — ' + destLabel(c, itemById(panel.threadId));
    const turns = c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    panel.sessText.textContent = c.sessionId
      ? 'session ' + String(c.sessionId).slice(0, 4) + ' · ' + turns + ' msgs'
      : c.loading
        ? 'loading…'
        : 'new session';
    panel.dot.className = c.streaming ? 'live' : c.failure ? 'err' : '';
    panel.send.disabled = !!c.streaming;
    panel.stop.style.display = c.streaming ? '' : 'none';
    panel.ta.placeholder = c.streaming
      ? 'Claude is replying…'
      : 'Message Claude about this thread…';
  }

  function scrollDown(force) {
    if (!panel) return;
    if (force || panel.pinned) panel.body.scrollTop = panel.body.scrollHeight;
  }

  /* --------------------------- history rendering ------------------------- */

  async function loadHistory(c) {
    c.loading = true;
    c.loadError = null;
    syncHead();
    try {
      const data = await apiJson('/api/thread/' + c.id + '/chat');
      c.destination = data && data.destination ? data.destination : null;
      c.sessionId = data && data.session ? data.session.id : null;
      // Carry live draft state across the refresh, keyed by message id + position, so a
      // reload never throws away an edit in progress or re-arms an already-sent card.
      const previous = new Map();
      c.messages.forEach((m) => {
        (m.drafts || []).forEach((d, i) => previous.set(m.key + '#' + i, d));
      });
      c.messages = ((data && data.messages) || []).map((m) => ({
        key: 'm' + m.id,
        role: String(m.role || ''),
        text: String(m.text || ''),
        at: m.at || null,
        drafts: (m.drafts || []).map((t, i) => {
          const old = previous.get('m' + m.id + '#' + i);
          if (!old) return mkDraft(t);
          old.node = null;
          return old;
        }),
      }));
      c.loaded = true;
    } catch (err) {
      c.loadError = String((err && err.message) || err);
    } finally {
      c.loading = false;
      if (panel && panel.threadId === c.id) {
        renderHistory(c);
        syncHead();
      }
    }
  }

  function mkDraft(text) {
    return { text: String(text || ''), state: 'idle', error: null, permalink: null, node: null };
  }

  function renderHistory(c) {
    if (!panel || panel.threadId !== c.id) return;
    panel.body.replaceChildren();
    panel.streamNode = null;
    panel.streamBubble = null;

    if (c.loading && !c.loaded) {
      panel.body.appendChild(el('div', 'sysnote', 'loading conversation…'));
      return;
    }
    if (c.loadError) {
      panel.body.appendChild(
        banner('This conversation could not be loaded.', c.loadError, null, () => {
          void loadHistory(c);
        }),
      );
      return;
    }
    if (c.messages.length === 0) {
      const empty = el('div', 'cempty');
      empty.appendChild(
        document.createTextNode('Claude already has this thread and its analysis. Ask anything — '),
      );
      empty.appendChild(el('b', null, '“draft a reply”'));
      empty.appendChild(document.createTextNode(', “what is this really about?”, “who is waiting on me?”.'));
      panel.body.appendChild(empty);
      panel.body.appendChild(
        el('div', 'sysnote', 'nothing is ever posted to Slack without your click'),
      );
    }
    c.messages.forEach((m) => panel.body.appendChild(messageNode(c, m)));
    if (c.failure) panel.body.appendChild(failureBanner(c));
    scrollDown(true);
  }

  function appendMessage(c, m) {
    c.messages.push(m);
    if (panel && panel.threadId === c.id) {
      panel.body.appendChild(messageNode(c, m));
      scrollDown(false);
    }
  }

  function messageNode(c, m) {
    if (m.role === 'user') {
      const wrap = el('div', 'cmsg user');
      wrap.appendChild(el('div', 'cwho', 'you'));
      const b = el('div', 'cbubble');
      renderPlain(b, m.text);
      wrap.appendChild(b);
      return wrap;
    }
    if (m.role === 'assistant') {
      const wrap = el('div', 'cmsg assistant');
      wrap.appendChild(el('div', 'cwho', 'claude'));
      if (m.text) {
        const b = el('div', 'cbubble');
        renderRich(b, m.text);
        wrap.appendChild(b);
      }
      (m.drafts || []).forEach((d) => wrap.appendChild(draftCard(c, d)));
      return wrap;
    }
    if (m.role === 'sent') {
      const note = el('div', 'sysnote');
      note.appendChild(document.createTextNode('sent to Slack '));
      if (httpUrlOrNull(m.text)) {
        note.appendChild(document.createTextNode('· '));
        note.appendChild(link(m.text, 'view in Slack'));
      }
      return note;
    }
    if (m.role === 'error') {
      const e = el('div', 'sysnote');
      e.style.color = 'var(--p0)';
      e.textContent = m.text;
      return e;
    }
    return el('div', 'sysnote', m.text);
  }

  /* ----------------------------- text rendering -------------------------- */
  /* Model output is untrusted. Everything below builds real nodes; no innerHTML. */

  const URL_RE = /https?:\/\/[^\s<>()"']+/g;

  /** Plain text with newlines preserved and bare http(s) URLs linkified. */
  function renderPlain(host, text) {
    String(text == null ? '' : text)
      .split('\n')
      .forEach((line, i) => {
        if (i > 0) host.appendChild(document.createElement('br'));
        linkify(host, line);
      });
  }

  function linkify(host, line) {
    const s = String(line);
    let last = 0;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(s)) !== null) {
      if (m.index > last) host.appendChild(document.createTextNode(s.slice(last, m.index)));
      host.appendChild(link(m[0], m[0]));
      last = m.index + m[0].length;
    }
    if (last < s.length) host.appendChild(document.createTextNode(s.slice(last)));
  }

  /**
   * Claude's prose: paragraphs plus fenced code blocks. Deliberately not a Markdown
   * engine — the goal is "readable and provably inert", so fences become <pre> with
   * textContent and everything else is plain text with linkified URLs.
   */
  function renderRich(host, text) {
    const lines = String(text == null ? '' : text).split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length === 0) return;
      const p = el('p');
      renderPlain(p, para.join('\n'));
      host.appendChild(p);
      para = [];
    };
    while (i < lines.length) {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (open) {
        flush();
        const closeRe = new RegExp('^\\s{0,3}' + (open[1][0] === '~' ? '~' : '`') + '{' + open[1].length + ',}\\s*$');
        const buf = [];
        let j = i + 1;
        for (; j < lines.length && !closeRe.test(lines[j]); j++) buf.push(lines[j]);
        host.appendChild(el('pre', null, buf.join('\n')));
        i = j < lines.length ? j + 1 : j;
        continue;
      }
      if (lines[i].trim() === '') {
        flush();
        i++;
        continue;
      }
      para.push(lines[i]);
      i++;
    }
    flush();
  }

  /* ---------------------------- draft-reply card ------------------------- */
  /* THE ONLY SEND PATH. See src/chat.ts: the server takes the text from this
     request body, never from anything the model holds. */

  function draftCard(c, d) {
    const card = el('div', 'draftcard');
    d.node = card;
    paintDraft(c, d);
    return card;
  }

  function paintDraft(c, d) {
    const card = d.node;
    if (!card) return;
    const label = (c.destination && c.destination.label) || destLabel(c, itemById(c.id));
    card.className = 'draftcard' + (d.state === 'sent' ? ' done' : '');
    card.replaceChildren();

    const head = el('div', 'dhead');
    head.appendChild(document.createTextNode('draft reply → '));
    head.appendChild(el('b', null, label));
    head.appendChild(document.createTextNode(' · as you'));
    card.appendChild(head);

    if (d.state === 'sent') {
      const row = el('div', 'dsent');
      row.appendChild(document.createTextNode('✓ Sent ' + (d.sentAt || clockNow())));
      if (d.dryRun) row.appendChild(el('span', 'dnote', 'dry run — nothing left this machine'));
      else if (httpUrlOrNull(d.permalink)) row.appendChild(link(d.permalink, 'view in Slack'));
      card.appendChild(row);
      const body = el('div', 'dnote');
      body.textContent = d.text;
      card.appendChild(body);
      return;
    }

    const ta = el('textarea');
    ta.value = d.text;
    ta.disabled = d.state === 'sending';
    ta.addEventListener('input', () => {
      d.text = ta.value;
    });
    ta.addEventListener('keydown', (e) => {
      // ⌘/ctrl+enter sends — scoped to this textarea, never a global key.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void sendDraft(c, d);
      }
    });
    card.appendChild(ta);

    const row = el('div', 'drow');
    const send = el('button', 'dsend', d.state === 'sending' ? 'Posting…' : 'Send to ' + label);
    send.disabled = d.state === 'sending';
    send.addEventListener('click', () => void sendDraft(c, d));
    row.appendChild(send);

    const copy = el('button', 'dbtn', 'Copy');
    copy.addEventListener('click', () => {
      const done = () => {
        copy.textContent = 'Copied ✓';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(d.text).then(done, () => {
          copy.textContent = 'Copy failed';
        });
      } else {
        ta.select();
        done();
      }
    });
    row.appendChild(copy);

    const discard = el('button', 'dbtn', 'Discard');
    discard.addEventListener('click', () => {
      card.remove();
      d.node = null;
    });
    row.appendChild(discard);
    card.appendChild(row);

    if (d.error) {
      const err = el('div', 'derr');
      err.appendChild(document.createTextNode(d.error + ' — '));
      const retry = el('button', 'dbtn', 'Retry');
      retry.addEventListener('click', () => void sendDraft(c, d));
      err.appendChild(retry);
      card.appendChild(err);
    }

    const note = el('div', 'dnote');
    note.appendChild(document.createTextNode('Posts as you. '));
    note.appendChild(el('b', null, 'Nothing sends without this click'));
    note.appendChild(document.createTextNode(' (⌘enter while editing works too).'));
    card.appendChild(note);
  }

  async function sendDraft(c, d) {
    if (d.state === 'sending' || d.state === 'sent') return;
    const text = String(d.text || '').trim();
    if (text === '') {
      d.error = 'Nothing to send — the draft is empty.';
      paintDraft(c, d);
      return;
    }
    d.state = 'sending';
    d.error = null;
    paintDraft(c, d);
    try {
      const out = await apiJson('/api/thread/' + c.id + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      d.state = 'sent';
      d.permalink = out && out.permalink;
      d.dryRun = !!(out && out.dry_run);
      d.sentAt = clockNow();
    } catch (err) {
      d.state = 'idle';
      d.error = String((err && err.message) || err);
    }
    paintDraft(c, d);
  }

  /* ------------------------------- banners ------------------------------- */

  function banner(msg, hint, command, onRetry) {
    const b = el('div', 'cbanner');
    b.appendChild(el('div', 'bmsg', msg));
    if (hint) b.appendChild(el('div', 'bhint', hint));
    if (command) {
      const row = el('div', 'brow');
      row.appendChild(el('code', null, command));
      b.appendChild(row);
    }
    if (onRetry) {
      const row = el('div', 'brow');
      const r = el('button', 'dbtn', 'Retry');
      r.addEventListener('click', onRetry);
      row.appendChild(r);
      b.appendChild(row);
    }
    return b;
  }

  function failureBanner(c) {
    const f = c.failure;
    return banner(f.message, f.hint, f.command || null, () => {
      const text = c.lastUserText;
      c.failure = null;
      renderHistory(c);
      if (text) void runTurn(c, text, true);
    });
  }

  /* -------------------------------- turns -------------------------------- */

  function submitComposer() {
    if (!panel) return;
    const c = convo(panel.threadId);
    if (c.streaming) return;
    const text = panel.ta.value.trim();
    if (text === '') return;
    panel.ta.value = '';
    c.composer = '';
    void runTurn(c, text, false);
  }

  function stopTurn(c) {
    if (c.abort) {
      try {
        c.abort.abort();
      } catch (_) {
        /* already gone */
      }
    }
  }

  /** Cut a partially-streamed draft fence out of the live view; the server's parse
   *  is authoritative and lands with the final `assistant` event. */
  function liveText(raw) {
    const m = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*draft\b/i.exec(raw);
    if (!m) return { text: raw, drafting: false };
    return { text: raw.slice(0, m.index), drafting: true };
  }

  function startStreamNode(c) {
    if (!panel || panel.threadId !== c.id) return;
    const wrap = el('div', 'cmsg assistant');
    wrap.appendChild(el('div', 'cwho', 'claude'));
    const bubble = el('div', 'cbubble');
    bubble.appendChild(el('span', 'ccursor', '▍'));
    wrap.appendChild(bubble);
    panel.body.appendChild(wrap);
    panel.streamNode = wrap;
    panel.streamBubble = bubble;
    scrollDown(false);
  }

  function paintStream(c) {
    if (!panel || panel.threadId !== c.id || !panel.streamBubble) return;
    const live = liveText(c.streamRaw);
    const b = panel.streamBubble;
    b.replaceChildren();
    if (live.text) renderRich(b, live.text);
    if (live.drafting) b.appendChild(el('div', 'dnote', '✎ writing a draft reply…'));
    b.appendChild(el('span', 'ccursor', '▍'));
    scrollDown(false);
  }

  function dropStreamNode() {
    if (panel && panel.streamNode) {
      panel.streamNode.remove();
      panel.streamNode = null;
      panel.streamBubble = null;
    }
  }

  function toolRow(c, ev) {
    if (!panel || panel.threadId !== c.id) return;
    if (ev.phase === 'start') {
      const r = el('div', 'ctool', '⚙ ' + ev.name + ' …');
      r.dataset.tool = ev.name;
      panel.body.insertBefore(r, panel.streamNode || null);
      scrollDown(false);
      return;
    }
    const rows = panel.body.querySelectorAll('.ctool');
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.dataset.done !== '1' && (r.dataset.tool === ev.name || ev.name === 'tool')) {
        r.dataset.done = '1';
        r.className = 'ctool ' + (ev.ok === false ? 'bad' : 'ok');
        r.textContent = '⚙ ' + r.dataset.tool + (ev.ok === false ? ' ✕' : ' ✓');
        return;
      }
    }
  }

  async function runTurn(c, text, isRetry) {
    if (c.streaming) return;
    c.streaming = true;
    c.failure = null;
    c.lastUserText = text;
    if (!isRetry) {
      appendMessage(c, { key: 'u' + Date.now(), role: 'user', text: text, at: null, drafts: [] });
    }
    c.streamRaw = '';
    startStreamNode(c);
    syncHead();

    const ac = new AbortController();
    c.abort = ac;
    let sawAssistant = false;

    try {
      const res = await apiFetch('/api/thread/' + c.id + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: ac.signal,
      });
      if (res.status === 401) {
        onAuthFailure();
        throw new Error('unauthorized');
      }
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          if (j && (j.error || j.message)) msg = String(j.message || j.error);
        } catch (_) {
          /* keep the status */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const payload = block
            .split('\n')
            .filter((l) => l.indexOf('data:') === 0)
            .map((l) => l.slice(5).trim())
            .join('');
          if (payload === '') continue; // heartbeat comment
          let ev = null;
          try {
            ev = JSON.parse(payload);
          } catch (_) {
            continue;
          }
          if (!ev || typeof ev.type !== 'string') continue;
          if (ev.type === 'session') {
            c.sessionId = ev.sessionId;
            syncHead();
          } else if (ev.type === 'delta') {
            c.streamRaw += String(ev.text || '');
            paintStream(c);
          } else if (ev.type === 'tool') {
            toolRow(c, ev);
          } else if (ev.type === 'assistant') {
            sawAssistant = true;
            dropStreamNode();
            appendMessage(c, {
              // same key shape as loadHistory, so a later refresh matches this turn's
              // drafts to their live cards instead of resetting them
              key: 'm' + ev.id,
              role: 'assistant',
              text: String(ev.text || ''),
              at: ev.at || null,
              drafts: (ev.drafts || []).map(mkDraft),
            });
          } else if (ev.type === 'error') {
            if (ev.kind === 'resume') {
              if (panel && panel.threadId === c.id) {
                panel.body.insertBefore(el('div', 'sysnote', ev.message), panel.streamNode || null);
              }
            } else {
              c.failure = {
                kind: ev.kind,
                message: ev.message,
                hint: ev.hint,
                // The fix command comes from the server, which knows WHICH harness is
                // running. Inventing 'claude auth login' here told a Codex user to sign
                // in to the wrong product; render what we are given, and nothing if the
                // failure has no command.
                command: ev.command || null,
              };
            }
          }
        }
      }
      if (!sawAssistant && !c.failure) {
        c.failure = {
          kind: 'unknown',
          message: 'Claude did not finish this reply.',
          hint: 'Try again — the connection ended before an answer arrived.',
          command: null,
        };
      }
    } catch (err) {
      const aborted = ac.signal.aborted;
      dropStreamNode();
      if (aborted) {
        if (panel && panel.threadId === c.id) {
          panel.body.appendChild(el('div', 'sysnote', '— stopped —'));
        }
      } else {
        c.failure = {
          kind: 'network',
          message: 'Could not reach the copilot server.',
          hint: String((err && err.message) || err),
          command: null,
        };
      }
    } finally {
      dropStreamNode();
      c.streaming = false;
      c.abort = null;
      if (panel && panel.threadId === c.id) {
        if (c.failure) panel.body.appendChild(failureBanner(c));
        syncHead();
        scrollDown(false);
        panel.ta.focus();
      }
    }
  }

  /* ------------------------- globals index.html calls --------------------- */

  function openChat(id, seed) {
    const st = S();
    if (id != null && id !== st.cursor) call('setCursor', id, { markSeen: true });
    else if (id != null) {
      const it = itemById(id);
      if (it && it.status === 'new') call('setStatus', id, 'seen');
    }
    st.chatOpen = true;
    st.focusPane = 'chat';
    document.body.classList.remove('chat-closed');
    const target = id != null ? id : st.cursor;
    if (target != null && seed) convo(target).composer = seed;
    renderChat();
    if (panel) {
      if (seed) panel.ta.value = seed;
      panel.ta.focus();
      try {
        panel.ta.setSelectionRange(panel.ta.value.length, panel.ta.value.length);
      } catch (_) {
        /* not focusable yet */
      }
    }
  }

  function closeChat() {
    const st = S();
    st.chatOpen = false;
    st.chatSeed = '';
    st.focusPane = 'thread';
    document.body.classList.add('chat-closed');
    teardownPanel();
    const scroller = document.getElementById('tscroll');
    if (scroller) scroller.focus();
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  /** Called by index.html's 5s render loop as well as by us — must stay cheap. */
  function renderChat() {
    const st = S();
    if (!st.chatOpen) {
      if (panel) teardownPanel();
      return;
    }
    const id = st.cursor;
    if (id == null) {
      if (!panel || panel.threadId !== null) {
        teardownPanel();
        chatEl.appendChild(el('div', 'sysnote', 'select a thread to chat about it'));
        panel = { threadId: null };
      }
      return;
    }
    if (!panel || panel.threadId !== id) {
      buildPanel(id);
      return;
    }
    syncHead();
  }

  if (!hostFetch) {
    // Without the page's token wrapper we cannot talk to /api at all; say so rather
    // than shipping a panel that fails on every keystroke.
    window.renderChat = function () {
      if (!S().chatOpen) {
        chatEl.replaceChildren();
        return;
      }
      if (chatEl.childElementCount === 0) {
        chatEl.appendChild(
          banner(
            'Chat could not attach to this page.',
            'public/chat.js expects apiFetch() as a global in index.html. Reload; if it persists, the page script changed shape.',
            null,
            null,
          ),
        );
      }
    };
    return;
  }

  window.openChat = openChat;
  window.closeChat = closeChat;
  window.renderChat = renderChat;
  // Test hook: exercised by the browser check, harmless in normal use.
  window.__chat = { convo: convo, convos: convos, render: renderChat, parseLive: liveText };

  if (S().chatOpen) renderChat();
})();
