/**
 * CHARACTERIZATION — src/db.ts: the store and the rules baked into its SQL.
 *
 * Everything runs against a throwaway database in the OS temp dir (see helpers/env.ts).
 * The live `data.db` is never opened.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  raw,
  resetDb,
  seedThread,
  seedMessage,
  seedSlackUser,
  slackUserRow,
  threadRow,
  messageRows,
  countRows,
} from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);

beforeEach(() => {
  resetDb();
});

const newThread = (over: Partial<Parameters<typeof db.insertThread>[0]> = {}) => ({
  workspace: 'A',
  teamName: 'Acme',
  channelId: 'C1',
  channelName: 'general',
  threadTs: '1700000000.000100',
  kind: 'mention' as const,
  lastActivity: '1700000000.000100',
  permalink: null,
  ...over,
});

// ---------------------------------------------------------------------------
// thread upsert race
// ---------------------------------------------------------------------------

test('insertThread: the first caller creates, the second gets the same row back', () => {
  const first = db.insertThread(newThread());
  const second = db.insertThread(newThread({ channelName: 'different', permalink: 'https://x' }));

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(countRows('threads'), 1);
  // DO NOTHING: the loser's values are discarded, the winner's row is untouched.
  assert.equal(threadRow(first.id)?.channel_name, 'general');
  assert.equal(threadRow(first.id)?.permalink, null);
});

test('insertThread race: BOTH racing messages land, neither is lost', () => {
  // Two events for the same brand-new thread interleave through async lookups.
  const a = db.insertThread(newThread());
  const b = db.insertThread(newThread());
  assert.equal(db.insertMessage({ threadId: a.id, ts: '1700000000.000100', authorId: 'U1', authorName: 'A', text: 'first', raw: null }), true);
  assert.equal(db.insertMessage({ threadId: b.id, ts: '1700000000.000200', authorId: 'U2', authorName: 'B', text: 'second', raw: null }), true);
  assert.deepEqual(messageRows(a.id).map((m) => m.text), ['first', 'second']);
});

test('insertThread: the unique key is (workspace, channel_id, thread_ts)', () => {
  const base = db.insertThread(newThread());
  assert.equal(db.insertThread(newThread({ workspace: 'B' })).created, true);
  assert.equal(db.insertThread(newThread({ channelId: 'C2' })).created, true);
  assert.equal(db.insertThread(newThread({ threadTs: '1700000000.000200' })).created, true);
  assert.equal(countRows('threads'), 4);
  assert.equal(db.findThread('A', 'C1', '1700000000.000100')?.id, base.id);
  assert.equal(db.findThread('A', 'C1', 'nope'), undefined);
});

test('insertThread: a new thread is born unread', () => {
  const { id } = db.insertThread(newThread());
  assert.equal(threadRow(id)?.status, 'new');
});

// ---------------------------------------------------------------------------
// message dedup
// ---------------------------------------------------------------------------

test('insertMessage: a duplicate (thread_id, ts) is ignored and reported as false', () => {
  const id = seedThread();
  assert.equal(db.insertMessage({ threadId: id, ts: '1.1', authorId: 'U1', authorName: 'A', text: 'x', raw: null }), true);
  assert.equal(db.insertMessage({ threadId: id, ts: '1.1', authorId: 'U1', authorName: 'A', text: 'DIFFERENT', raw: null }), false);
  assert.equal(messageRows(id).length, 1);
  assert.equal(messageRows(id)[0].text, 'x', 'the original text is kept, not overwritten');
});

test('insertMessage: the same ts in a different thread is a different message', () => {
  const one = seedThread({ channel_id: 'C1', thread_ts: '1' });
  const two = seedThread({ channel_id: 'C2', thread_ts: '2' });
  assert.equal(db.insertMessage({ threadId: one, ts: '1.1', authorId: null, authorName: null, text: 'a', raw: null }), true);
  assert.equal(db.insertMessage({ threadId: two, ts: '1.1', authorId: null, authorName: null, text: 'b', raw: null }), true);
  assert.equal(countRows('messages'), 2);
});

test('getMessagesForThread: ordered by ts numerically, not lexicographically', () => {
  const id = seedThread();
  for (const ts of ['1000.000200', '999.000000', '1000.000100']) seedMessage({ thread_id: id, ts });
  assert.deepEqual(db.getMessagesForThread(id).map((m) => m.ts), [
    '999.000000',
    '1000.000100',
    '1000.000200',
  ]);
});

// ---------------------------------------------------------------------------
// last_activity only ever moves forward
// ---------------------------------------------------------------------------

test('markThreadActive: marks unread and moves last_activity forward only', () => {
  const id = seedThread({ status: 'done', last_activity: '1000.000500' });

  db.markThreadActive(id, '1000.000900');
  assert.equal(threadRow(id)?.last_activity, '1000.000900');
  assert.equal(threadRow(id)?.status, 'new', 'new activity re-opens the thread');

  db.markThreadActive(id, '1000.000100'); // a backfilled older message
  assert.equal(threadRow(id)?.last_activity, '1000.000900', 'never dragged backwards');
});

test('markThreadActive: the comparison is numeric', () => {
  const id = seedThread({ last_activity: '1000.000000' });
  db.markThreadActive(id, '999.000000'); // lexicographically larger, numerically smaller
  assert.equal(threadRow(id)?.last_activity, '1000.000000');
});

test('markThreadActive: a NULL last_activity is always overwritten', () => {
  const id = seedThread({ last_activity: null });
  db.markThreadActive(id, '1000.000100');
  assert.equal(threadRow(id)?.last_activity, '1000.000100');
});

test('touchThreadActivity: moves last_activity forward but never touches status', () => {
  const id = seedThread({ status: 'done', last_activity: '1000.000500' });
  db.touchThreadActivity(id, '1000.000900');
  assert.equal(threadRow(id)?.last_activity, '1000.000900');
  assert.equal(threadRow(id)?.status, 'done', 'my own reply must not re-open a finished thread');
  db.touchThreadActivity(id, '1000.000100');
  assert.equal(threadRow(id)?.last_activity, '1000.000900');
});

test('markThreadSeenIfNew: only ever demotes a "new" row', () => {
  const fresh = seedThread({ channel_id: 'C1', thread_ts: '1', status: 'new' });
  const seen = seedThread({ channel_id: 'C2', thread_ts: '2', status: 'seen' });
  const done = seedThread({ channel_id: 'C3', thread_ts: '3', status: 'done' });

  assert.equal(db.markThreadSeenIfNew(fresh), true);
  assert.equal(threadRow(fresh)?.status, 'seen');
  assert.equal(db.markThreadSeenIfNew(seen), false);
  assert.equal(db.markThreadSeenIfNew(done), false);
  assert.equal(threadRow(done)?.status, 'done', 'a finished thread is never dragged backwards');
  assert.equal(db.markThreadSeenIfNew(999_999), false);
});

// ---------------------------------------------------------------------------
// status validation: the two triggers standing in for a CHECK constraint
// ---------------------------------------------------------------------------

test('status trigger: an invalid status cannot be inserted', () => {
  assert.throws(
    () => seedThread({ status: 'archived' }),
    /threads\.status must be new, seen or done/,
  );
  assert.throws(() => seedThread({ status: '' }), /threads\.status must be new, seen or done/);
  assert.throws(() => seedThread({ status: 'NEW' }), /threads\.status must be new, seen or done/);
});

test('status trigger: an invalid status cannot be written by an update', () => {
  const id = seedThread();
  assert.throws(
    () => raw().prepare('UPDATE threads SET status = ? WHERE id = ?').run('archived', id),
    /threads\.status must be new, seen or done/,
  );
  assert.equal(threadRow(id)?.status, 'new');
});

test('status trigger: an unrelated update to a legacy row with an odd status still works', () => {
  // Create a row the trigger would reject, exactly as a pre-trigger database could hold.
  const triggerSql = (
    raw()
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='threads_status_insert_guard'")
      .get() as { sql: string }
  ).sql;
  raw().exec('DROP TRIGGER threads_status_insert_guard');
  const id = seedThread({ status: 'legacy-weird' });
  raw().exec(triggerSql);

  // An update that does not change `status` is allowed through.
  raw().prepare('UPDATE threads SET channel_name = ? WHERE id = ?').run('renamed', id);
  assert.equal(threadRow(id)?.channel_name, 'renamed');
  assert.equal(threadRow(id)?.status, 'legacy-weird');

  // Healing it to a valid status is allowed; making it worse is not.
  raw().prepare('UPDATE threads SET status = ? WHERE id = ?').run('seen', id);
  assert.equal(threadRow(id)?.status, 'seen');
});

test('setThreadStatus: validates before the trigger, with its own message', () => {
  const id = seedThread();
  assert.equal(db.setThreadStatus(id, 'done'), true);
  assert.equal(threadRow(id)?.status, 'done');
  assert.equal(db.setThreadStatus(999_999, 'seen'), false, 'unknown id changes nothing');
  assert.throws(
    () => db.setThreadStatus(id, 'archived' as 'done'),
    /setThreadStatus: invalid status "archived"/,
  );
});

// ---------------------------------------------------------------------------
// the feed: urgency band, then recency, unrated last
// ---------------------------------------------------------------------------

function rate(threadId: number, urgency: string | null): void {
  db.upsertAnalysis({
    threadId,
    urgency: urgency as string,
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: '1',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'sess',
  });
}

test('getFeed: sorted by urgency band, then by recency; unrated threads come last', () => {
  const mk = (n: string, at: string): number => seedThread({ channel_id: `C${n}`, thread_ts: n, last_activity: at });
  const p3 = mk('1', '1000.000100');
  const p0old = mk('2', '1000.000100');
  const p0new = mk('3', '2000.000100');
  const p1 = mk('4', '3000.000100');
  const unrated = mk('5', '9000.000100'); // newest of all, but never analyzed
  const unknownBand = mk('6', '8000.000100');
  rate(p3, 'P3');
  rate(p0old, 'P0');
  rate(p0new, 'P0');
  rate(p1, 'P1');
  rate(unknownBand, 'P9'); // an urgency nobody recognises falls in the ELSE bucket

  assert.deepEqual(db.getFeed().map((f) => f.id), [p0new, p0old, p1, p3, unrated, unknownBand]);
});

test('getFeed: recency ordering is numeric', () => {
  const older = seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: '999.000000' });
  const newer = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: '1000.000000' });
  assert.deepEqual(db.getFeed().map((f) => f.id), [newer, older]);
});

test('getFeed: carries the newest message and a message count', () => {
  const id = seedThread({ last_activity: '1000.000300' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'first', author_name: 'Alice' });
  seedMessage({ thread_id: id, ts: '1000.000300', text: 'latest', author_name: 'Bob' });
  seedMessage({ thread_id: id, ts: '1000.000200', text: 'middle', author_name: 'Carol' });

  const [item] = db.getFeed();
  assert.equal(item.message_count, 3);
  assert.deepEqual(item.last_message, {
    author_id: 'U_OTHER',
    author_name: 'Bob',
    text: 'latest',
    ts: '1000.000300',
  });
});

test('getFeed: a thread with no messages has last_message null and count 0', () => {
  seedThread();
  const [item] = db.getFeed();
  assert.equal(item.last_message, null);
  assert.equal(item.message_count, 0);
});

test('getFeed: analysis fields are null when there is no analysis row', () => {
  seedThread();
  const [item] = db.getFeed();
  assert.deepEqual(
    { urgency: item.urgency, why: item.why, summary: item.summary, suggested_action: item.suggested_action },
    { urgency: null, why: null, summary: null, suggested_action: null },
  );
});

// ---------------------------------------------------------------------------
// edits and deletions
// ---------------------------------------------------------------------------

test('updateMessageText: rewrites the text and reports which thread changed', () => {
  const id = seedThread({ workspace: 'A', channel_id: 'C1' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'before' });

  assert.deepEqual(
    db.updateMessageText({ workspace: 'A', channelId: 'C1', ts: '1000.000100', text: 'after', raw: '{}' }),
    { threadId: id, changed: true },
  );
  assert.equal(messageRows(id)[0].text, 'after');
  assert.equal(messageRows(id)[0].raw, '{}');
});

test('updateMessageText: a message we never stored returns null', () => {
  const id = seedThread({ workspace: 'A', channel_id: 'C1' });
  seedMessage({ thread_id: id, ts: '1000.000100' });
  assert.equal(db.updateMessageText({ workspace: 'A', channelId: 'C1', ts: '9999.9', text: 'x', raw: null }), null);
  assert.equal(db.updateMessageText({ workspace: 'B', channelId: 'C1', ts: '1000.000100', text: 'x', raw: null }), null);
  assert.equal(db.updateMessageText({ workspace: 'A', channelId: 'C2', ts: '1000.000100', text: 'x', raw: null }), null);
});

test('updateMessageText: an edit never touches status or last_activity', () => {
  const id = seedThread({ status: 'done', last_activity: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'typo' });
  db.updateMessageText({ workspace: 'A', channelId: 'C1', ts: '1000.000100', text: 'fixed', raw: null });
  assert.equal(threadRow(id)?.status, 'done');
  assert.equal(threadRow(id)?.last_activity, '1000.000100');
});

test('markMessageDeleted: replaces the text with "(deleted)" and stamps deleted_at', () => {
  const id = seedThread();
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'oops' });

  assert.deepEqual(db.markMessageDeleted({ workspace: 'A', channelId: 'C1', ts: '1000.000100' }), {
    threadId: id,
    changed: true,
  });
  const row = messageRows(id)[0];
  assert.equal(row.text, '(deleted)');
  assert.match(String(row.deleted_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(countRows('messages'), 1, 'the row survives — no hole in the transcript');
});

test('markMessageDeleted: deleting twice reports changed:false the second time', () => {
  const id = seedThread();
  seedMessage({ thread_id: id, ts: '1000.000100' });
  db.markMessageDeleted({ workspace: 'A', channelId: 'C1', ts: '1000.000100' });
  assert.deepEqual(db.markMessageDeleted({ workspace: 'A', channelId: 'C1', ts: '1000.000100' }), {
    threadId: id,
    changed: false,
  });
});

test('updateMessageText: a deleted message stays deleted even if Slack sends an edit', () => {
  const id = seedThread();
  seedMessage({ thread_id: id, ts: '1000.000100' });
  db.markMessageDeleted({ workspace: 'A', channelId: 'C1', ts: '1000.000100' });
  assert.deepEqual(
    db.updateMessageText({ workspace: 'A', channelId: 'C1', ts: '1000.000100', text: 'resurrected', raw: null }),
    { threadId: id, changed: false },
  );
  assert.equal(messageRows(id)[0].text, '(deleted)');
});

test('markAnalysisStale: clears covered_through_ts but keeps the visible verdict', () => {
  const id = seedThread();
  rate(id, 'P1');
  db.markAnalysisStale(id);
  const a = db.getAnalysisForThread(id);
  assert.equal(a?.covered_through_ts, null);
  assert.equal(a?.urgency, 'P1');
  assert.equal(a?.why, 'w');
  db.markAnalysisStale(999_999); // no row: a silent no-op
});

// ---------------------------------------------------------------------------
// catch-up state
// ---------------------------------------------------------------------------

test('sync marks: absent until set, then only ever move forward', () => {
  assert.equal(db.getSyncMark('A', 'C1'), null);
  db.setSyncMark('A', 'C1', '1000.000100');
  assert.equal(db.getSyncMark('A', 'C1'), '1000.000100');
  db.setSyncMark('A', 'C1', '2000.000100');
  assert.equal(db.getSyncMark('A', 'C1'), '2000.000100');
  db.setSyncMark('A', 'C1', '500.000100');
  assert.equal(db.getSyncMark('A', 'C1'), '2000.000100', 'a mark never moves backwards');
  assert.equal(db.getSyncMark('B', 'C1'), null, 'marks are per workspace');
});

test('latestStoredTsForChannel: the newest message we hold for a conversation', () => {
  const id = seedThread({ workspace: 'A', channel_id: 'C1' });
  assert.equal(db.latestStoredTsForChannel('A', 'C1'), null);
  seedMessage({ thread_id: id, ts: '999.000000' });
  seedMessage({ thread_id: id, ts: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000050' });
  assert.equal(db.latestStoredTsForChannel('A', 'C1'), '1000.000100');
  assert.equal(db.latestStoredTsForChannel('A', 'C2'), null);
});

test('listTrackedConversations: distinct channels for one workspace', () => {
  seedThread({ workspace: 'A', channel_id: 'C1', thread_ts: '1', kind: 'mention' });
  seedThread({ workspace: 'A', channel_id: 'C1', thread_ts: '2', kind: 'mention' });
  seedThread({ workspace: 'A', channel_id: 'D9', thread_ts: 'D9', kind: 'dm' });
  seedThread({ workspace: 'B', channel_id: 'C7', thread_ts: '1', kind: 'mention' });

  const tracked = db
    .listTrackedConversations('A')
    .map((c) => ({ channel_id: c.channel_id, kind: c.kind }))
    .sort((x, y) => x.channel_id.localeCompare(y.channel_id));
  assert.deepEqual(tracked, [
    { channel_id: 'C1', kind: 'mention' },
    { channel_id: 'D9', kind: 'dm' },
  ]);
  assert.deepEqual(db.listTrackedConversations('Z'), []);
});

test('listRecentMentionThreads: mention threads only, newest first, capped', () => {
  seedThread({ channel_id: 'D1', thread_ts: 'D1', kind: 'dm', last_activity: '9000.000000' });
  const a = seedThread({ channel_id: 'C1', thread_ts: '1', kind: 'mention', last_activity: '1000.000000' });
  const b = seedThread({ channel_id: 'C2', thread_ts: '2', kind: 'mention', last_activity: '3000.000000' });
  seedThread({ channel_id: 'C3', thread_ts: '3', kind: 'mention', last_activity: '10.000000' }); // too old
  seedThread({ channel_id: 'C4', thread_ts: '4', kind: 'mention', last_activity: null });
  assert.equal(a > 0 && b > 0, true);

  const recent = (limit: number): Array<{ channel_id: string; thread_ts: string }> =>
    db.listRecentMentionThreads('A', '100.000000', limit).map((r) => ({ channel_id: r.channel_id, thread_ts: r.thread_ts }));
  assert.deepEqual(recent(10), [
    { channel_id: 'C2', thread_ts: '2' },
    { channel_id: 'C1', thread_ts: '1' },
  ]);
  assert.deepEqual(recent(1), [{ channel_id: 'C2', thread_ts: '2' }]);
  assert.deepEqual(db.listRecentMentionThreads('A', '100.000000', 0), [], 'a zero budget asks for nothing');
  assert.deepEqual(db.listRecentMentionThreads('A', '100.000000', -5), []);
});

// ---------------------------------------------------------------------------
// who the people are: the slack_users table
// ---------------------------------------------------------------------------

const profile = (over: Partial<Parameters<typeof db.upsertSlackUser>[0]> = {}) => ({
  workspace: 'A',
  userId: 'U_ELLEN',
  displayName: 'Ellen',
  realName: 'Ellen Example',
  title: 'VP Operations',
  isAdmin: true,
  isOwner: false,
  isPrimaryOwner: false,
  isBot: false,
  tz: 'America/Los_Angeles',
  tzLabel: 'Pacific Daylight Time',
  ...over,
});

test('upsertSlackUser: stores the profile, booleans as 1/0, and stamps updated_at', () => {
  db.upsertSlackUser(profile());
  const row = db.getSlackUser('A', 'U_ELLEN');
  assert.equal(row?.display_name, 'Ellen');
  assert.equal(row?.real_name, 'Ellen Example');
  assert.equal(row?.title, 'VP Operations');
  assert.equal(row?.is_admin, 1);
  assert.equal(row?.is_owner, 0);
  assert.equal(row?.is_bot, 0);
  assert.equal(row?.tz_label, 'Pacific Daylight Time');
  assert.match(String(row?.updated_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(db.getSlackUser('A', 'U_NOBODY'), undefined);
  assert.equal(db.getSlackUser('B', 'U_ELLEN'), undefined, 'profiles are per workspace');
});

test('upsertSlackUser: "Slack did not say" is null, never false', () => {
  db.upsertSlackUser(
    profile({ title: null, isAdmin: null, isOwner: null, isPrimaryOwner: null, isBot: null, tz: null, tzLabel: null }),
  );
  const row = db.getSlackUser('A', 'U_ELLEN');
  assert.equal(row?.title, null);
  assert.equal(row?.is_admin, null);
  assert.equal(row?.is_bot, null);
});

test('upsertSlackUser: a later, thinner lookup never erases what we already knew', () => {
  db.upsertSlackUser(profile());
  // Slack answers again, this time without the title or the flags (hidden profile fields,
  // a partial response, a workspace that does not expose them).
  db.upsertSlackUser(profile({ displayName: 'Ellen V.', title: null, isAdmin: null, tzLabel: null }));
  const row = db.getSlackUser('A', 'U_ELLEN');
  assert.equal(row?.display_name, 'Ellen V.', 'a value Slack did send is updated');
  assert.equal(row?.title, 'VP Operations', 'and one it omitted is kept');
  assert.equal(row?.is_admin, 1);
  assert.equal(row?.tz_label, 'Pacific Daylight Time');
  assert.equal(countRows('slack_users'), 1, 'one row per (workspace, user)');
});

test('upsertSlackUser: Slack actively contradicting a flag does overwrite it', () => {
  db.upsertSlackUser(profile({ isAdmin: true }));
  db.upsertSlackUser(profile({ isAdmin: false }));
  assert.equal(db.getSlackUser('A', 'U_ELLEN')?.is_admin, 0);
});

test('getSlackUsers: the people we know, keyed by id; strangers are simply absent', () => {
  seedSlackUser({ user_id: 'U1', display_name: 'One', title: 'CEO' });
  seedSlackUser({ user_id: 'U2', display_name: 'Two' });
  seedSlackUser({ workspace: 'B', user_id: 'U3', display_name: 'Three' });

  const found = db.getSlackUsers('A', ['U1', 'U2', 'U1', 'U3', '']);
  assert.deepEqual([...found.keys()].sort(), ['U1', 'U2']);
  assert.equal(found.get('U1')?.title, 'CEO');
  assert.equal(db.getSlackUsers('A', []).size, 0);
});

test('listUserIdsNeedingProfile: missing or stale profiles, most recently active first', () => {
  const id = seedThread({ workspace: 'A' });
  seedMessage({ thread_id: id, ts: '1000.000100', author_id: 'U_OLD' });
  seedMessage({ thread_id: id, ts: '3000.000100', author_id: 'U_NEW' });
  seedMessage({ thread_id: id, ts: '2000.000100', author_id: 'U_KNOWN' });
  seedMessage({ thread_id: id, ts: '2500.000100', author_id: 'U_STALE' });
  seedMessage({ thread_id: id, ts: '2600.000100', author_id: null });
  seedSlackUser({ user_id: 'U_KNOWN', updated_at: '2026-08-01T00:00:00.000Z' });
  seedSlackUser({ user_id: 'U_STALE', updated_at: '2026-01-01T00:00:00.000Z' });

  const cutoff = '2026-07-01T00:00:00.000Z';
  assert.deepEqual(db.listUserIdsNeedingProfile('A', cutoff, 10), ['U_NEW', 'U_STALE', 'U_OLD']);
  assert.deepEqual(db.listUserIdsNeedingProfile('A', cutoff, 1), ['U_NEW'], 'capped');
  assert.deepEqual(db.listUserIdsNeedingProfile('A', cutoff, 0), [], 'a zero budget asks for nothing');
  assert.deepEqual(db.listUserIdsNeedingProfile('B', cutoff, 10), [], 'per workspace');
});

test('listUserIdsNeedingProfile: a profile with no timestamp counts as missing', () => {
  const id = seedThread();
  seedMessage({ thread_id: id, author_id: 'U_BLANK' });
  seedSlackUser({ user_id: 'U_BLANK', updated_at: null });
  assert.deepEqual(db.listUserIdsNeedingProfile('A', '2026-07-01T00:00:00.000Z', 10), ['U_BLANK']);
});

test('slack_users is additive: nothing else in the schema changed shape', () => {
  // The table is new, so an existing database gains it without a rebuild; the row it holds
  // is keyed on (workspace, user_id) and nothing references it, so a profile can never
  // block a message from being stored.
  const cols = (raw().prepare('PRAGMA table_info(slack_users)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
  assert.deepEqual(cols, [
    'display_name',
    'is_admin',
    'is_bot',
    'is_owner',
    'is_primary_owner',
    'real_name',
    'title',
    'tz',
    'tz_label',
    'updated_at',
    'user_id',
    'workspace',
  ]);
  assert.deepEqual(
    (raw().prepare('PRAGMA foreign_key_list(slack_users)').all() as unknown[]).length,
    0,
  );
  seedSlackUser({ user_id: 'U_X' });
  assert.equal(slackUserRow('A', 'U_X')?.display_name, 'Other Person');
});

// ---------------------------------------------------------------------------
// WATCH-START RULE (db side): set once, never moved
// ---------------------------------------------------------------------------

test('ensureWatchStart: records the first connect and never moves it again', () => {
  assert.equal(db.getWatchStart('A'), null);

  const first = db.ensureWatchStart('A', 1_700_000_000);
  assert.equal(first, 1_700_000_000);
  assert.equal(db.getWatchStart('A'), 1_700_000_000);

  // A restart an hour later must not re-classify the intervening history.
  assert.equal(db.ensureWatchStart('A', 1_700_003_600), 1_700_000_000);
  assert.equal(db.getWatchStart('A'), 1_700_000_000);
  // …not even if the clock goes backwards.
  assert.equal(db.ensureWatchStart('A', 1_600_000_000), 1_700_000_000);

  assert.equal(db.getWatchStart('B'), null, 'the mark is per workspace');
  assert.equal(db.ensureWatchStart('B', 1_700_000_500), 1_700_000_500);
});

test('the watch-start row lives under a reserved channel id that cannot collide', () => {
  db.ensureWatchStart('A', 1_700_000_000);
  const rows = raw().prepare('SELECT channel_id FROM sync_state').all() as Array<{ channel_id: string }>;
  assert.deepEqual(rows.map((r) => r.channel_id), ['__watch_start__']);
  // Real Slack conversation ids are C…/D…/G…, so the reserved key is unreachable, and it
  // is invisible to the normal per-channel mark lookup.
  assert.equal(db.getSyncMark('A', 'C__watch_start__'), null);
});

test('markPreWatchThreadsSeen: one-time cleanup, guarded by a marker row', () => {
  const old1 = seedThread({ channel_id: 'C1', thread_ts: '1', status: 'new', last_activity: '1000.000000' });
  const old2 = seedThread({ channel_id: 'C2', thread_ts: '2', status: 'new', last_activity: null });
  const recent = seedThread({ channel_id: 'C3', thread_ts: '3', status: 'new', last_activity: '3000.000000' });
  const done = seedThread({ channel_id: 'C4', thread_ts: '4', status: 'done', last_activity: '1000.000000' });

  const result = db.markPreWatchThreadsSeen(2_000);
  assert.equal(result.ran, true);
  assert.equal(result.markedSeen, 2);
  assert.equal(threadRow(old1)?.status, 'seen');
  assert.equal(threadRow(old2)?.status, 'seen', 'a thread with no activity stamp counts as history');
  assert.equal(threadRow(recent)?.status, 'new', 'anything after the cutoff stays unread');
  assert.equal(threadRow(done)?.status, 'done', 'a finished thread is never touched');
  assert.ok(result.backupPath !== null && result.backupPath.startsWith(db.DB_PATH));

  // Second call: the marker row means there is nothing to do, ever again.
  db.setThreadStatus(recent, 'new');
  const again = db.markPreWatchThreadsSeen(9_999);
  assert.equal(again.ran, false);
  assert.equal(again.markedSeen, 0);
  assert.equal(again.backupPath, null);
  assert.equal(threadRow(recent)?.status, 'new', 'a deliberate "mark unread" can never be undone');
});

test('markPreWatchThreadsSeen: with nothing unread it claims the marker without a backup', () => {
  seedThread({ status: 'seen' });
  const result = db.markPreWatchThreadsSeen(2_000);
  assert.deepEqual(
    { ran: result.ran, backup: result.backupPath, marked: result.markedSeen },
    { ran: false, backup: null, marked: 0 },
  );
  assert.notEqual(db.getSyncMark('__meta__', '__history_seen_v1__'), null);
});

// ---------------------------------------------------------------------------
// the DM re-keying migration (idempotent, backed up, transactional)
// ---------------------------------------------------------------------------

test('migrateDmThreadKeys: folds per-message DM rows into one row keyed on the channel', () => {
  const a = seedThread({ channel_id: 'D1', thread_ts: '1000.000100', kind: 'dm', status: 'seen', last_activity: '1000.000100', channel_name: null });
  const b = seedThread({ channel_id: 'D1', thread_ts: '1000.000200', kind: 'dm', status: 'new', last_activity: '1000.000200', channel_name: 'Ruby' });
  const other = seedThread({ channel_id: 'C9', thread_ts: '1000.000300', kind: 'mention' });
  seedMessage({ thread_id: a, ts: '1000.000100' });
  seedMessage({ thread_id: b, ts: '1000.000200' });
  rate(b, 'P2');

  const result = db.migrateDmThreadKeys();
  assert.equal(result.ran, true);
  assert.equal(result.groupsMerged, 1);
  assert.ok(result.backupPath !== null);

  const survivors = raw().prepare("SELECT * FROM threads WHERE kind = 'dm'").all() as Array<Record<string, unknown>>;
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].thread_ts, 'D1', 'DMs are keyed on the conversation');
  assert.equal(survivors[0].status, 'new', "'new' beats 'seen' when merging");
  assert.equal(survivors[0].last_activity, '1000.000200');
  assert.equal(survivors[0].channel_name, 'Ruby', 'a name is inherited from whichever row had one');
  assert.equal(messageRows(Number(survivors[0].id)).length, 2, 'both sides of the conversation survive');
  assert.equal(threadRow(other)?.thread_ts, '1000.000300', 'mention threads are never touched');

  // Idempotent: a second run finds no work and writes nothing.
  const second = db.migrateDmThreadKeys();
  assert.equal(second.ran, false);
  assert.equal(second.backupPath, null);
});

test('migrateDmThreadKeys: a single already-canonical DM row is left alone', () => {
  seedThread({ channel_id: 'D1', thread_ts: 'D1', kind: 'dm' });
  const result = db.migrateDmThreadKeys();
  assert.equal(result.ran, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.threadsAfter, result.threadsBefore);
});
