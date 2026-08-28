'use strict';
/* =========================================================================
   Ordo — chat panel. Owns the #chat pane; nothing else in the app
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
        // "Continue in Claude Code" — see paintHandoff. Collapsed until asked for.
        handoff: {
          loaded: false, loading: false, canLaunch: false,
          chat: null, analysis: null,
          open: false, busy: null, shown: {}, note: null,
        },
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

    // "Continue in Claude Code" lives between the transcript and the composer: it is
    // an exit from this panel, not part of the conversation, and it must not push the
    // composer off screen — so it is one collapsed line until someone wants it.
    const ho = el('div', 'hocard');
    ho.style.display = 'none';

    chatEl.replaceChildren(head, body, ho, comp);
    panel = {
      threadId: id,
      who: who,
      dot: dot,
      sessText: sessText,
      body: body,
      ho: ho,
      ta: ta,
      send: send,
      stop: stop,
      pinned: true,
      streamNode: null,
      streamBubble: null,
    };

    renderHistory(c);
    syncHead();
    paintHandoff(c);
    if (!c.handoff.loaded) void loadHandoff(c);
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
        id: typeof m.id === 'number' ? m.id : null,
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

  /** "↺ restart from here" — only on rows the server knows (they have a db id). */
  function whoRow(c, m, label) {
    const who = el('div', 'cwho', label);
    if (m.id != null) {
      const r = el('button', 'crewind', '↺');
      r.title = 'Restart the conversation from this point — this message and everything after are discarded. Claude keeps its knowledge of the thread.';
      r.addEventListener('click', () => {
        if (c.streaming) return;
        if (window.confirm('Restart the conversation from this message? Everything after it is discarded.')) {
          void resetConversation(c, m.id);
        }
      });
      who.appendChild(r);
    }
    return who;
  }

  function messageNode(c, m) {
    if (m.role === 'user') {
      const wrap = el('div', 'cmsg user');
      wrap.appendChild(whoRow(c, m, 'you'));
      const b = el('div', 'cbubble');
      renderPlain(b, m.text);
      wrap.appendChild(b);
      return wrap;
    }
    if (m.role === 'assistant') {
      const wrap = el('div', 'cmsg assistant');
      wrap.appendChild(whoRow(c, m, 'claude'));
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
  /*
   * Markdown-lite → DOM. The model writes standard markdown (bold, bullets, headings,
   * inline code); rendering it as raw asterisks made long answers unreadable. Still no
   * innerHTML anywhere — every branch builds real nodes from untrusted text.
   */
  function renderInline(host, text) {
    const src = String(text == null ? '' : text);
    const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\n]+)\*|_([^_\n]+)_/g;
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      // _emphasis_ only on word boundaries — protects snake_case identifiers.
      if (m[6] !== undefined) {
        const before = src.charAt(m.index - 1);
        const after = src.charAt(m.index + m[0].length);
        if (/\w/.test(before) || /\w/.test(after)) {
          re.lastIndex = m.index + 1;
          continue;
        }
      }
      if (m.index > last) linkify(host, src.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) host.appendChild(el('code', null, m[1]));
      else if (m[2] !== undefined) {
        const b = el('strong');
        renderInline(b, m[2]);
        host.appendChild(b);
      } else if (m[3] !== undefined) {
        const safe = httpUrlOrNull(m[4]);
        if (safe) host.appendChild(link(safe, m[3]));
        else linkify(host, m[0]);
      } else {
        const emText = m[5] !== undefined ? m[5] : m[6];
        const e = el('em');
        renderInline(e, emText);
        host.appendChild(e);
      }
    }
    if (last < src.length) linkify(host, src.slice(last));
  }

  function renderRich(host, text) {
    const lines = String(text == null ? '' : text).split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length === 0) return;
      const p = el('p');
      para.forEach((line, k) => {
        if (k > 0) p.appendChild(document.createElement('br'));
        renderInline(p, line);
      });
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
      const line = lines[i];
      if (line.trim() === '') {
        flush();
        i++;
        continue;
      }
      // Bullets and numbered lists — consume the whole run into one list element.
      const bullet = /^\s{0,3}[-*•]\s+(.*)$/.exec(line);
      const numbered = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flush();
        const listEl = el(bullet ? 'ul' : 'ol');
        while (i < lines.length) {
          const b = /^\s{0,3}[-*•]\s+(.*)$/.exec(lines[i]);
          const n = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/.exec(lines[i]);
          const item = bullet ? b : n;
          if (!item) break;
          const li = el('li');
          renderInline(li, item[1]);
          listEl.appendChild(li);
          i++;
        }
        host.appendChild(listEl);
        continue;
      }
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const h = el('p', 'mdh');
        const b = el('strong');
        renderInline(b, heading[1]);
        h.appendChild(b);
        host.appendChild(h);
        i++;
        continue;
      }
      const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (quote) {
        flush();
        const q = el('div', 'mdq');
        while (i < lines.length) {
          const qq = /^\s{0,3}>\s?(.*)$/.exec(lines[i]);
          if (!qq) break;
          const ln = el('div');
          renderInline(ln, qq[1]);
          q.appendChild(ln);
          i++;
        }
        host.appendChild(q);
        continue;
      }
      para.push(line);
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
    const it = itemById(c.id);
    // Email is read-only end to end: there is no send path to offer, so the card says
    // where the draft goes instead of pretending a Send button exists.
    const isEmail = !!(it && it.source === 'gmail');
    const label = (c.destination && c.destination.label) || destLabel(c, it);
    card.className = 'draftcard' + (d.state === 'sent' ? ' done' : '');
    card.replaceChildren();

    const head = el('div', 'dhead');
    head.appendChild(document.createTextNode('draft reply → '));
    head.appendChild(el('b', null, isEmail ? 'copy into Gmail' : label));
    if (!isEmail) head.appendChild(document.createTextNode(' · as you'));
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
        if (!isEmail) void sendDraft(c, d);
      }
    });
    card.appendChild(ta);

    const row = el('div', 'drow');
    if (!isEmail) {
      const send = el('button', 'dsend', d.state === 'sending' ? 'Posting…' : 'Send to ' + label);
      send.disabled = d.state === 'sending';
      send.addEventListener('click', () => void sendDraft(c, d));
      row.appendChild(send);
    } else if (it && httpUrlOrNull(it.permalink)) {
      row.appendChild(link(it.permalink, 'Open in Gmail'));
    }

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

  /* --------------------- continue in Claude Code ------------------------- */
  /* The panel's exit hatch: hand one of this thread's two Claude sessions to the
     real CLI, where Claude has tools and can go and DO the thing this panel
     deliberately cannot. The two sessions behave differently, so they are two
     separately-labelled entries — and the analysis one carries a warning, because
     a session that answers with a rating looks broken if you were not told.

     The Mac app can open a terminal itself; a browser cannot, so it shows the same
     command with a Copy button (the classes come from index.html's setup banner,
     so it is the same thing the user has already seen). A launch that fails falls
     back to exactly that too — never a button that appears to do nothing. */

  async function loadHandoff(c) {
    const h = c.handoff;
    if (h.loading) return;
    h.loading = true;
    try {
      const d = await apiJson('/api/thread/' + c.id + '/handoff');
      h.chat = d && d.chat ? d.chat : null;
      h.analysis = d && d.analysis ? d.analysis : null;
      h.canLaunch = !!(d && d.canLaunch);
    } catch (_) {
      // An older server without the route, or a blip: offer nothing rather than a
      // broken button. The chat itself is unaffected.
      h.chat = null;
      h.analysis = null;
    }
    h.loaded = true;
    h.loading = false;
    if (panel && panel.threadId === c.id) paintHandoff(c);
  }

  async function openInClaudeCode(c, target) {
    const h = c.handoff;
    if (!h[target] || h.busy) return;
    if (!h.canLaunch) {
      h.shown[target] = true;
      paintHandoff(c);
      return;
    }
    h.busy = target;
    h.note = null;
    paintHandoff(c);
    try {
      const out = await apiJson('/api/thread/' + c.id + '/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target }),
      });
      h.note = {
        target: target,
        tone: 'good',
        text: 'Opened ' + ((out && out.terminal) || 'Terminal') + ' — Claude is picking up where it left off.',
      };
    } catch (err) {
      h.shown[target] = true;
      h.note = {
        target: target,
        tone: 'bad',
        text: String((err && err.message) || 'Could not open a terminal.') + ' Run this yourself instead:',
      };
    }
    h.busy = null;
    paintHandoff(c);
  }

  /** Same command row the setup banner uses, including its copy behaviour. */
  function commandRow(cmd) {
    const row = el('div', 'cmdrow');
    row.appendChild(el('span', 'lead', 'Open Terminal and run:'));
    const cmdNode = el('code', 'cmd', cmd);
    cmdNode.title = 'click to select, then copy';
    row.appendChild(cmdNode);
    const copy = el('button', 'copybtn', 'Copy');
    copy.title = 'copy this command';
    copy.addEventListener('click', () => {
      if (typeof window.copyCommand === 'function') {
        window.copyCommand(cmd, copy, cmdNode);
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(
          () => {
            copy.textContent = 'Copied';
            copy.classList.add('done');
          },
          () => {
            copy.textContent = 'Press ⌘C';
          },
        );
      }
    });
    row.appendChild(copy);
    return row;
  }

  function paintHandoff(c) {
    if (!panel || panel.threadId !== c.id || !panel.ho) return;
    const h = c.handoff;
    const host = panel.ho;
    host.replaceChildren();
    if (!h.loaded || (!h.chat && !h.analysis)) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';

    const toggle = el('button', 'hotoggle');
    toggle.appendChild(el('span', null, h.open ? '▾' : '▸'));
    toggle.appendChild(el('span', null, 'Continue in Claude Code'));
    toggle.title = 'keep talking in the terminal, where Claude can use its tools';
    toggle.addEventListener('click', () => {
      h.open = !h.open;
      paintHandoff(c);
    });
    host.appendChild(toggle);
    if (!h.open) return;

    host.appendChild(
      el('div', 'hosub',
        'Claude gets its tools back there — it can go and change things, not just draft a reply.'),
    );

    let first = true;
    const item = (target, label, describe, warn) => {
      if (!h[target]) return;
      const wrap = el('div', 'hoitem' + (first ? ' first' : ''));
      first = false;
      wrap.appendChild(el('div', 'holabel', label));
      wrap.appendChild(el('div', 'hosub', describe));
      if (warn) wrap.appendChild(el('div', 'howarn', warn));
      if (h.canLaunch) {
        const b = el('button', 'hobtn', h.busy === target ? 'Opening…' : 'Open in Claude Code');
        b.disabled = !!h.busy;
        b.addEventListener('click', () => void openInClaudeCode(c, target));
        const row = el('div', 'cmdrow');
        row.appendChild(b);
        wrap.appendChild(row);
      }
      // The outcome belongs to the button that produced it, and "…run this yourself"
      // goes above the command it introduces.
      const mine = h.note && h.note.target === target && h.busy === null;
      const note = mine ? el('div', 'honote ' + h.note.tone, h.note.text) : null;
      if (note && h.note.tone === 'bad') wrap.appendChild(note);
      if (!h.canLaunch || h.shown[target]) wrap.appendChild(commandRow(h[target].command));
      if (note && h.note.tone === 'good') wrap.appendChild(note);
      host.appendChild(wrap);
    };

    item('chat', 'Continue this chat', 'Reopens this conversation exactly where you left it.');
    item(
      'analysis',
      'See why it was rated this way',
      'Reopens the session that gave this message its urgency and summary.',
      'Heads-up: that session was told to answer only with a rating, so its first reply will ' +
        'look like raw data. Ask it to talk normally and it will.',
    );

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
    // "/new": fresh conversation, same thread knowledge (the next turn re-briefs from
    // the transcript and triage). Nothing goes to the model for the command itself.
    if (text === '/new' || text === '/reset') {
      void resetConversation(c, null);
      return;
    }
    void runTurn(c, text, false);
  }

  async function resetConversation(c, fromId) {
    try {
      await apiJson('/api/thread/' + c.id + '/chat/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fromId != null ? { from_id: fromId } : {}),
      });
      c.messages = [];
      c.sessionId = null;
      await loadHistory(c);
      appendMessage(c, {
        key: 'sys' + Date.now(),
        role: 'system',
        text: fromId != null
          ? 'Conversation restarted from here — everything after was discarded. Claude still knows the thread.'
          : 'Fresh conversation — Claude still knows the thread.',
        at: null,
        drafts: [],
      });
    } catch (err) {
      appendMessage(c, {
        key: 'err' + Date.now(),
        role: 'error',
        text: "Couldn't restart the conversation: " + String((err && err.message) || err),
        at: null,
        drafts: [],
      });
    }
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

  /*
   * One quiet, collapsible row per turn instead of a box per call ("all those tool
   * call boxes seem annoying"). Discovery calls (ToolSearch) are plumbing and never
   * shown; real lookups aggregate into per-service counts, expandable on click.
   */
  function toolLabel(name) {
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    if (!m) return name || 'lookup';
    return m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
  }

  function toolRow(c, ev) {
    if (!panel || panel.threadId !== c.id) return;
    if (ev.name === 'ToolSearch') return;
    let g = panel.toolGroup;
    if (!g) {
      g = {
        node: el('div', 'ctoolgroup'),
        head: el('button', 'ctoolhead'),
        list: el('div', 'ctoollist'),
        calls: [], open: false, inflight: 0,
      };
      g.list.style.display = 'none';
      g.head.addEventListener('click', () => {
        g.open = !g.open;
        g.list.style.display = g.open ? '' : 'none';
        paintToolGroup(g);
      });
      g.node.appendChild(g.head);
      g.node.appendChild(g.list);
      panel.body.insertBefore(g.node, panel.streamNode || null);
      panel.toolGroup = g;
    }
    if (ev.phase === 'start') {
      g.calls.push({ name: ev.name, done: false, ok: null });
      g.inflight += 1;
    } else {
      const call = g.calls.find((x) => !x.done && x.name === ev.name) || g.calls.find((x) => !x.done);
      if (call) {
        call.done = true;
        call.ok = ev.ok !== false;
        g.inflight = Math.max(0, g.inflight - 1);
      }
    }
    paintToolGroup(g);
    scrollDown(false);
  }

  function paintToolGroup(g) {
    const byService = new Map();
    let failed = 0;
    for (const call of g.calls) {
      const s = toolLabel(call.name);
      byService.set(s, (byService.get(s) || 0) + 1);
      if (call.done && call.ok === false) failed += 1;
    }
    const parts = [...byService.entries()].map(([s, n]) => s + (n > 1 ? ' ×' + n : ''));
    let label = (g.inflight > 0 ? '⚙ Checking ' : '⚙ Checked ') + parts.join(' · ') + (g.inflight > 0 ? '…' : '');
    if (failed > 0) label += ' · ' + failed + " couldn't be read";
    g.head.textContent = label + (g.open ? '  ▾' : '  ▸');
    g.list.replaceChildren();
    for (const call of g.calls) {
      g.list.appendChild(el('div', 'ctool ' + (call.done ? (call.ok ? 'ok' : 'bad') : ''),
        (call.done ? (call.ok ? '✓ ' : '✕ ') : '… ') + call.name));
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
    if (panel && panel.threadId === c.id) panel.toolGroup = null; // fresh lookup group per turn
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
      // The first turn is what creates the resumable chat session, and any turn can
      // replace it (a failed resume starts a fresh one). Re-ask rather than hand out a
      // session id that no longer exists — and tell the thread pane, which caches its
      // own copy of the same answer.
      if (c.sessionId && (!c.handoff.chat || c.handoff.chat.sessionId !== c.sessionId)) {
        void loadHandoff(c);
        if (typeof window.loadHandoff === 'function') void window.loadHandoff(c.id);
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
