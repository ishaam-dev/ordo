'use strict';
/**
 * Watches the feed so the menubar can show a count and macOS can raise a
 * notification when something urgent lands.
 *
 * The feed API is protected by a per-run token that the server injects into the
 * page it serves. We get it the same way the page does — by asking for '/' and
 * reading it out of the HTML — so the app is just another client of the same
 * guarded API. The token is never written to the log or to disk.
 *
 * Notification rules, in order of importance:
 *   - only P0 and P1, never P2/P3
 *   - only threads that are still marked "new"
 *   - each thread at most once, ever (remembered across restarts)
 *   - nothing at all on the very first run, so installing the app is silent
 *   - at most 3 at a time; beyond that, one "N urgent items" summary
 */
const { EventEmitter } = require('node:events');
const { Notification } = require('electron');
const { baseUrl, log, readJson, userDataFile, writeJson } = require('./env');

const POLL_MS = 15_000;
const URGENT = new Set(['P0', 'P1']);
const MAX_NOTIFICATIONS_PER_POLL = 3;
const MAX_REMEMBERED = 3000;

class FeedWatcher extends EventEmitter {
  constructor() {
    super();
    this.token = null;
    this.timer = null;
    this.paused = false;
    this.polling = false;
    this.counts = { urgent: 0, total: 0 };
    this.lastOkAt = 0;
    const saved = readJson(userDataFile('notified.json'));
    this.seeded = Boolean(saved && saved.seeded);
    this.notified = new Set(Array.isArray(saved && saved.ids) ? saved.ids : []);
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.poll();
  }

  /** Forget the cached token — used when the server restarts and mints a new one. */
  forgetToken() {
    this.token = null;
  }

  async fetchToken() {
    const res = await fetch(baseUrl() + '/', {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`page returned ${res.status}`);
    const html = await res.text();
    const named = html.match(/COPILOT_TOKEN\s*[=:]\s*['"]([0-9a-fA-F]{32,128})['"]/);
    const bare = html.match(/\b[0-9a-f]{64}\b/);
    const token = named ? named[1] : bare ? bare[0] : null;
    if (!token) throw new Error('could not read the access token from the page');
    return token;
  }

  async fetchFeed(token) {
    const res = await fetch(baseUrl() + '/api/feed', {
      signal: AbortSignal.timeout(6000),
      headers: { 'x-copilot-token': token, accept: 'application/json' },
    });
    if (res.status === 401) return { unauthorized: true };
    if (!res.ok) throw new Error(`feed returned ${res.status}`);
    const data = await res.json();
    return { items: Array.isArray(data) ? data : [] };
  }

  async poll() {
    if (this.paused || this.polling) return;
    this.polling = true;
    try {
      if (!this.token) this.token = await this.fetchToken();
      let result = await this.fetchFeed(this.token);
      if (result.unauthorized) {
        // The server restarts with a fresh token; pick up the new one and retry once.
        this.token = await this.fetchToken();
        result = await this.fetchFeed(this.token);
        if (result.unauthorized) throw new Error('access token was rejected twice');
      }
      this.lastOkAt = Date.now();
      this.onFeed(result.items);
      this.emit('ok');
    } catch (err) {
      this.token = null;
      this.emit('error', err);
    } finally {
      this.polling = false;
    }
  }

  onFeed(items) {
    const urgent = items.filter((i) => URGENT.has(i.urgency) && i.status === 'new');
    const counts = { urgent: urgent.length, total: items.length };
    if (counts.urgent !== this.counts.urgent || counts.total !== this.counts.total) {
      this.counts = counts;
      this.emit('counts', counts);
    }

    if (!this.seeded) {
      // First ever run: adopt whatever is already there without making a sound.
      for (const item of urgent) this.notified.add(item.id);
      this.seeded = true;
      this.persist();
      log(`first run: adopted ${urgent.length} existing urgent item(s) without notifying`);
      return;
    }

    const fresh = urgent.filter((i) => !this.notified.has(i.id));
    if (fresh.length === 0) return;
    for (const item of fresh) this.notified.add(item.id);
    this.persist();

    if (fresh.length > MAX_NOTIFICATIONS_PER_POLL) {
      this.notify({
        title: `${fresh.length} urgent messages`,
        body: 'Open Slack Copilot to see them.',
        threadId: null,
      });
      return;
    }
    for (const item of fresh) this.notify(describe(item));
  }

  notify({ title, subtitle, body, threadId }) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, subtitle, body, silent: false });
    const what = threadId === null ? '(summary)' : threadId;
    n.on('click', () => this.emit('open-thread', threadId));
    n.on('show', () => log(`notification for thread ${what}: shown by macOS`));
    n.on('failed', (_e, err) => log(`notification for thread ${what} failed:`, String(err)));
    n.show();
    log(`notifying about thread ${what}`);
  }

  persist() {
    const ids = Array.from(this.notified).slice(-MAX_REMEMBERED);
    this.notified = new Set(ids);
    writeJson(userDataFile('notified.json'), { seeded: this.seeded, ids });
  }
}

/* ------------------------------------------------------------- helpers ----- */

/** Slack text is untrusted; notifications are plain text, but keep them tidy and short. */
function clean(value, max) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function describe(item) {
  const who = clean(
    (item.last_message && item.last_message.author_name) || item.channel_name || 'Slack',
    32,
  );
  const label = item.urgency === 'P0' ? 'Urgent' : 'Needs attention';
  const where =
    item.kind === 'mention'
      ? clean('#' + (item.channel_name || 'channel'), 40)
      : clean(item.team_name || 'Direct message', 40);
  const body =
    clean(item.why, 160) ||
    clean(item.summary, 160) ||
    clean(item.last_message && item.last_message.text, 160) ||
    'Open Slack Copilot to read it.';
  return {
    title: `${label} · ${who}`,
    subtitle: where,
    body,
    threadId: item.id,
  };
}

module.exports = { FeedWatcher };
