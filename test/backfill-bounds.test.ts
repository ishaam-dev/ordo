/**
 * CHARACTERIZATION — src/backfill.ts: the lookback arithmetic and the per-conversation
 * high-water-mark advance/hold rule.
 *
 * The Slack client is a double; no network call is made. Note that a couple of tests
 * deliberately pay the module's real 1.2s inter-call delay, because that delay is on the
 * path being characterised.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, seedThread, seedMessage } from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);
const { oldestFor, runBackfill } = await import('../src/backfill.js');

const DAY = 24 * 60 * 60;
const now = (): number => Date.now() / 1000;

/** A fresh workspace key per sweep — `runBackfill` debounces per key for 30s. */
let keyCounter = 0;
const nextKey = (): string => `WS${++keyCounter}`;

interface HistoryPage {
  messages: unknown[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface Doubles {
  dmChannels?: unknown[];
  historyPages?: HistoryPage[];
  replies?: unknown[];
  listThrows?: boolean;
  historyThrows?: boolean;
  repliesThrows?: boolean;
}

function client(d: Doubles): { calls: string[]; api: Record<string, unknown> } {
  const calls: string[] = [];
  let page = 0;
  const api = {
    conversations: {
      list: async () => {
        calls.push('conversations.list');
        if (d.listThrows) throw new Error('missing_scope');
        return { channels: d.dmChannels ?? [] };
      },
      history: async (args: { oldest: string }) => {
        calls.push(`conversations.history:${args.oldest}`);
        if (d.historyThrows) throw new Error('channel_not_found');
        const pages = d.historyPages ?? [{ messages: [] }];
        return pages[Math.min(page++, pages.length - 1)];
      },
      replies: async () => {
        calls.push('conversations.replies');
        if (d.repliesThrows) throw new Error('thread_not_found');
        return { messages: d.replies ?? [] };
      },
    },
    users: { conversations: async () => ({ channels: [] }) },
    search: {
      messages: async () => {
        throw new Error('missing_scope');
      },
    },
  };
  return { calls, api };
}

function context(
  key: string,
  api: Record<string, unknown>,
  ingest: (msg: { ts?: string }) => Promise<boolean>,
  onSweep?: (active: boolean, reason: string) => void,
): Parameters<typeof runBackfill>[0] {
  return {
    workspaceKey: key,
    client: api,
    myUserId: 'UME',
    myUserName: null, // no search.messages probe
    ingest: (msg: unknown) => ingest(msg as { ts?: string }),
    onSweep,
  };
}

beforeEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// where a sweep starts
// ---------------------------------------------------------------------------

const ctxFor = (key: string): Parameters<typeof oldestFor>[0] =>
  context(key, {}, async () => true);

test('oldestFor: first sight of a conversation looks back exactly 2 days', () => {
  const oldest = oldestFor(ctxFor('A'), 'C_NEW');
  assert.ok(Math.abs(oldest - (now() - 2 * DAY)) < 2, `got ${now() - oldest}s of lookback`);
});

test('oldestFor: a stored high-water mark wins', () => {
  db.setSyncMark('A', 'C1', (now() - 3_600).toFixed(6));
  assert.ok(Math.abs(oldestFor(ctxFor('A'), 'C1') - (now() - 3_600)) < 2);
});

test('oldestFor: with no mark, the newest stored message seeds the sweep', () => {
  const id = seedThread({ workspace: 'A', channel_id: 'C1' });
  seedMessage({ thread_id: id, ts: (now() - 900).toFixed(6) });
  assert.ok(Math.abs(oldestFor(ctxFor('A'), 'C1') - (now() - 900)) < 2);

  // …and the mark takes precedence over the stored message once it exists.
  db.setSyncMark('A', 'C1', (now() - 60).toFixed(6));
  assert.ok(Math.abs(oldestFor(ctxFor('A'), 'C1') - (now() - 60)) < 2);
});

test('oldestFor: no sweep ever reaches back more than 30 days', () => {
  db.setSyncMark('A', 'C1', '1000.000000'); // 1970
  const oldest = oldestFor(ctxFor('A'), 'C1');
  assert.ok(Math.abs(oldest - (now() - 30 * DAY)) < 2, `got ${(now() - oldest) / DAY} days`);
});

test('oldestFor: a mark that does not parse falls back to the 2-day first lookback', () => {
  db.setSyncMark('A', 'C1', 'not-a-number');
  assert.ok(Math.abs(oldestFor(ctxFor('A'), 'C1') - (now() - 2 * DAY)) < 2);
});

test('oldestFor: marks are per workspace and per channel', () => {
  db.setSyncMark('A', 'C1', (now() - 60).toFixed(6));
  assert.ok(Math.abs(oldestFor(ctxFor('B'), 'C1') - (now() - 2 * DAY)) < 2);
  assert.ok(Math.abs(oldestFor(ctxFor('A'), 'C2') - (now() - 2 * DAY)) < 2);
});

// ---------------------------------------------------------------------------
// the high-water mark: advance on success, hold on failure
// ---------------------------------------------------------------------------

test('a clean sweep advances the mark to ~now (minus 5 minutes of clock slack)', async () => {
  const key = nextKey();
  const { api, calls } = client({
    dmChannels: [{ id: 'D1' }],
    historyPages: [{ messages: [{ ts: '1000.000200', text: 'b' }, { ts: '1000.000100', text: 'a' }] }],
  });
  const seen: string[] = [];
  await runBackfill(
    context(key, api, async (m) => {
      seen.push(String(m.ts));
      return true;
    }),
    'incremental',
    'test',
  );

  assert.deepEqual(seen, ['1000.000100', '1000.000200'], 'messages are replayed oldest-first');
  const mark = Number(db.getSyncMark(key, 'D1'));
  assert.ok(Math.abs(mark - (now() - 300)) < 5, `mark was ${now() - mark}s ago`);
  assert.ok(calls.some((c) => c.startsWith('conversations.history:')));
});

test('a store failure leaves the mark unadvanced, so the window is re-offered', async () => {
  const key = nextKey();
  const { api } = client({
    dmChannels: [{ id: 'D1' }],
    historyPages: [{ messages: [{ ts: '1000.000100' }, { ts: '1000.000200' }, { ts: '1000.000300' }] }],
  });
  const offered: string[] = [];
  await runBackfill(
    context(key, api, async (m) => {
      offered.push(String(m.ts));
      if (m.ts === '1000.000200') throw new Error('disk on fire');
      return true;
    }),
    'incremental',
    'test',
  );

  assert.deepEqual(offered, ['1000.000100', '1000.000200', '1000.000300'], 'the sweep does not stop at the failure');
  assert.equal(db.getSyncMark(key, 'D1'), null, 'the mark must not advance past a message we lost');
});

test('an existing mark survives a failed sweep unchanged', async () => {
  const key = nextKey();
  db.setSyncMark(key, 'D1', '1500.000000');
  const { api } = client({ dmChannels: [{ id: 'D1' }], historyPages: [{ messages: [{ ts: '1600.000000' }] }] });
  await runBackfill(
    context(key, api, async () => {
      throw new Error('nope');
    }),
    'incremental',
    'test',
  );
  assert.equal(db.getSyncMark(key, 'D1'), '1500.000000');
});

test('a conversations.history failure skips the conversation without a mark', async () => {
  const key = nextKey();
  const { api } = client({ dmChannels: [{ id: 'D1' }], historyThrows: true });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  assert.equal(db.getSyncMark(key, 'D1'), null);
});

test('when pagination is truncated the mark only advances to what was actually read', async () => {
  const key = nextKey();
  const { api } = client({
    dmChannels: [{ id: 'D1' }],
    historyPages: [
      { messages: [{ ts: '1000.000100' }], has_more: true, response_metadata: { next_cursor: 'c1' } },
      { messages: [{ ts: '1000.000200' }], has_more: true, response_metadata: { next_cursor: 'c2' } },
      { messages: [{ ts: '1000.000300' }], has_more: true, response_metadata: { next_cursor: 'c3' } },
    ],
  });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  // Three pages is the cap: the mark is the newest message seen, NOT "now".
  assert.equal(db.getSyncMark(key, 'D1'), '1000.000300');
});

test('a conversations.replies failure also holds the mark', async () => {
  const key = nextKey();
  const { api } = client({
    dmChannels: [{ id: 'D1' }],
    historyPages: [
      {
        messages: [{ ts: (now() - 60).toFixed(6), reply_count: 2, latest_reply: now().toFixed(6) }],
      },
    ],
    repliesThrows: true,
  });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  assert.equal(db.getSyncMark(key, 'D1'), null);
});

test('replies are pushed through the same ingest path as history', async () => {
  const key = nextKey();
  const parentTs = (now() - 60).toFixed(6);
  const replyTs = (now() - 30).toFixed(6);
  const { api } = client({
    dmChannels: [{ id: 'D1' }],
    historyPages: [{ messages: [{ ts: parentTs, reply_count: 1, latest_reply: replyTs }] }],
    replies: [{ ts: parentTs }, { ts: replyTs }],
  });
  const seen: string[] = [];
  await runBackfill(
    context(key, api, async (m) => {
      seen.push(String(m.ts));
      return true;
    }),
    'incremental',
    'test',
  );
  assert.deepEqual(seen, [parentTs, replyTs], 'the parent is not re-offered by the replies call');
});

// ---------------------------------------------------------------------------
// sweep plumbing
// ---------------------------------------------------------------------------

test('a second sweep within 30 seconds of the first is debounced away', async () => {
  const key = nextKey();
  const { api, calls } = client({ dmChannels: [{ id: 'D1' }], historyPages: [{ messages: [] }] });
  const ctx = context(key, api, async () => true);
  await runBackfill(ctx, 'incremental', 'first');
  const after = calls.length;
  await runBackfill(ctx, 'incremental', 'second');
  assert.equal(calls.length, after, 'the reconnect-storm debounce swallowed the second sweep');
});

test('onSweep is called true-then-false, and a throwing hook cannot break the sweep', async () => {
  const key = nextKey();
  const { api } = client({ dmChannels: [{ id: 'D1' }], historyPages: [{ messages: [{ ts: '1000.000100' }] }] });
  const events: boolean[] = [];
  await runBackfill(
    context(key, api, async () => true, (active, reason) => {
      events.push(active);
      assert.equal(reason, 'wake');
      throw new Error('the UI blew up');
    }),
    'incremental',
    'wake',
  );
  assert.deepEqual(events, [true, false]);
  assert.notEqual(db.getSyncMark(key, 'D1'), null, 'the sweep still completed');
});

test('a failing conversations.list does not abort the sweep', async () => {
  const key = nextKey();
  const { api } = client({ listThrows: true });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  // Nothing to sweep, no throw, no marks written.
  assert.equal(db.getSyncMark(key, 'D1'), null);
});

test('an incremental sweep also visits conversations we already track', async () => {
  const key = nextKey();
  seedThread({ workspace: key, channel_id: 'C_TRACKED', thread_ts: '1', kind: 'mention', last_activity: '1000.000100' });
  const { api, calls } = client({ dmChannels: [], historyPages: [{ messages: [] }] });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  assert.equal(calls.filter((c) => c.startsWith('conversations.history')).length, 1);
  assert.notEqual(db.getSyncMark(key, 'C_TRACKED'), null);
});

test('deleted-user DM conversations are skipped', async () => {
  const key = nextKey();
  const { api, calls } = client({
    dmChannels: [{ id: 'D_GONE', is_user_deleted: true }, { id: 'D_OK' }],
    historyPages: [{ messages: [] }],
  });
  await runBackfill(context(key, api, async () => true), 'incremental', 'test');
  assert.equal(db.getSyncMark(key, 'D_GONE'), null);
  assert.notEqual(db.getSyncMark(key, 'D_OK'), null);
  assert.equal(calls.filter((c) => c.startsWith('conversations.history')).length, 1);
});
