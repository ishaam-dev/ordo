import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The live database. `COPILOT_DB_PATH` overrides it so migrations and race tests can be
 * exercised against a throwaway copy without going anywhere near the user's real data;
 * the app itself never sets it.
 */
export const DB_PATH = ((): string => {
  const override = (process.env.COPILOT_DB_PATH ?? '').trim();
  return override !== '' ? path.resolve(override) : path.join(projectRoot, 'data.db');
})();

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// The dev server, the packaged app and any test boot can all have this file open at once,
// and the catch-up sweep writes in bursts. Without a busy timeout the loser of a write
// lock fails instantly with SQLITE_BUSY and its message is lost.
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    team_name TEXT,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    thread_ts TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dm','mention')),
    status TEXT NOT NULL DEFAULT 'new',
    last_activity TEXT,
    permalink TEXT,
    UNIQUE(workspace, channel_id, thread_ts)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id),
    ts TEXT NOT NULL,
    author_id TEXT,
    author_name TEXT,
    text TEXT,
    raw TEXT,
    UNIQUE(thread_id, ts)
  );

  CREATE TABLE IF NOT EXISTS analyses (
    thread_id INTEGER PRIMARY KEY REFERENCES threads(id),
    urgency TEXT,
    why TEXT,
    summary TEXT,
    suggested_action TEXT,
    context_notes TEXT,
    covered_through_ts TEXT,
    analyzed_at TEXT,
    session_id TEXT
  );

  /*
   * Catch-up high-water marks (see src/backfill.ts). One row per Slack conversation we
   * have swept; last_ts is the newest message ts we have already processed there, so a
   * reconnect/wake only asks Slack for what came after it. Additive table — existing
   * databases pick it up on first run with no data migration.
   */
  CREATE TABLE IF NOT EXISTS sync_state (
    workspace TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_ts TEXT,
    updated_at TEXT,
    PRIMARY KEY (workspace, channel_id)
  );

  /*
   * threads.status is meant to be CHECK(status IN ('new','seen','done')), but SQLite cannot
   * add a CHECK to an existing table without rebuilding it — far too much risk to the
   * user's live database for an invariant we can enforce additively. These triggers are the
   * equivalent guard: same rejection, no data rewrite. The UPDATE guard only fires when the
   * status column actually changes, so an unrelated column update on a legacy row with an
   * odd status still succeeds.
   */
  CREATE TRIGGER IF NOT EXISTS threads_status_insert_guard
  BEFORE INSERT ON threads
  FOR EACH ROW WHEN NEW.status NOT IN ('new','seen','done')
  BEGIN
    SELECT RAISE(ABORT, 'threads.status must be new, seen or done');
  END;

  CREATE TRIGGER IF NOT EXISTS threads_status_update_guard
  BEFORE UPDATE OF status ON threads
  FOR EACH ROW WHEN NEW.status IS NOT OLD.status AND NEW.status NOT IN ('new','seen','done')
  BEGIN
    SELECT RAISE(ABORT, 'threads.status must be new, seen or done');
  END;
`);

/**
 * Additive column adds only — never a rebuild. `ALTER TABLE ADD COLUMN` on a populated
 * table is safe (SQLite only touches the schema; existing rows read the new column as
 * NULL), but it is not idempotent, so it is guarded by the current column list.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] added column ${table}.${column}`);
}

/*
 * A message deleted in Slack keeps its row — dropping it would leave a hole in the
 * transcript and could empty a card entirely — and is stamped here instead. Its `text` is
 * replaced with a plain "(deleted)" marker at the same time, so even a UI that knows
 * nothing about this column stops showing words the sender has taken back.
 */
addColumnIfMissing('messages', 'deleted_at', 'TEXT');

// ---------- row shapes ----------

export interface ThreadRow {
  id: number;
  workspace: string;
  team_name: string | null;
  channel_id: string;
  channel_name: string | null;
  thread_ts: string;
  kind: 'dm' | 'mention';
  status: string;
  last_activity: string | null;
  permalink: string | null;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  ts: string;
  author_id: string | null;
  author_name: string | null;
  text: string | null;
  raw: string | null;
  /** ISO time we saw Slack delete this message; null for every normal message. */
  deleted_at?: string | null;
}

export interface AnalysisRow {
  thread_id: number;
  urgency: string | null;
  why: string | null;
  summary: string | null;
  suggested_action: string | null;
  context_notes: string | null;
  covered_through_ts: string | null;
  analyzed_at: string | null;
  session_id: string | null;
}

export interface FeedItem {
  id: number;
  workspace: string;
  team_name: string | null;
  channel_name: string | null;
  kind: 'dm' | 'mention';
  status: string;
  last_activity: string | null;
  permalink: string | null;
  urgency: string | null;
  why: string | null;
  summary: string | null;
  suggested_action: string | null;
  last_message: { author_name: string | null; text: string | null; ts: string } | null;
  message_count: number;
}

/** A conversation we already track, for the cheap incremental catch-up sweep. */
export interface TrackedConversation {
  channel_id: string;
  kind: 'dm' | 'mention';
}

// ---------- prepared statements ----------

const stmtFindThread = db.prepare(
  'SELECT * FROM threads WHERE workspace = ? AND channel_id = ? AND thread_ts = ?',
);

/*
 * DO NOTHING (not "OR IGNORE"/plain INSERT) so that two events for the same brand-new
 * thread cannot make the loser throw: the caller re-reads the winner's row instead of
 * dropping a message. See insertThread().
 */
const stmtInsertThread = db.prepare(
  `INSERT INTO threads (workspace, team_name, channel_id, channel_name, thread_ts, kind, status, last_activity, permalink)
   VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)
   ON CONFLICT(workspace, channel_id, thread_ts) DO NOTHING`,
);

/*
 * last_activity only ever moves forward: a backfilled message that predates what we
 * already have must not drag the feed's ordering backwards.
 */
const stmtMarkActive = db.prepare(
  `UPDATE threads
      SET status = 'new',
          last_activity = CASE
            WHEN last_activity IS NULL OR CAST(? AS REAL) > CAST(last_activity AS REAL) THEN ?
            ELSE last_activity END
    WHERE id = ?`,
);

const stmtTouchActivity = db.prepare(
  `UPDATE threads
      SET last_activity = CASE
            WHEN last_activity IS NULL OR CAST(? AS REAL) > CAST(last_activity AS REAL) THEN ?
            ELSE last_activity END
    WHERE id = ?`,
);

const stmtInsertMessage = db.prepare(
  `INSERT OR IGNORE INTO messages (thread_id, ts, author_id, author_name, text, raw)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const stmtSeenIfNew = db.prepare("UPDATE threads SET status = 'seen' WHERE id = ? AND status = 'new'");

const stmtUpdateChannelName = db.prepare('UPDATE threads SET channel_name = ? WHERE id = ?');
const stmtUpdatePermalink = db.prepare('UPDATE threads SET permalink = ? WHERE id = ?');

/*
 * Edits and deletions arrive keyed on (channel, message ts) — Slack does not tell us which
 * of our threads the message ended up in, and a reply lives under its parent's thread row.
 * Both statements therefore find the message through its thread, which is correct whichever
 * way the message was keyed when we stored it.
 */
const stmtFindMessageByChannelTs = db.prepare(
  `SELECT m.id AS id, m.thread_id AS thread_id, m.deleted_at AS deleted_at
     FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.workspace = ? AND t.channel_id = ? AND m.ts = ?`,
);
const stmtUpdateMessageText = db.prepare(
  'UPDATE messages SET text = ?, raw = ? WHERE id = ?',
);
const stmtMarkMessageDeleted = db.prepare(
  "UPDATE messages SET text = '(deleted)', deleted_at = ? WHERE id = ?",
);
const stmtStaleAnalysis = db.prepare(
  'UPDATE analyses SET covered_through_ts = NULL WHERE thread_id = ?',
);

const stmtFeed = db.prepare(
  `SELECT
     t.id, t.workspace, t.team_name, t.channel_name, t.kind, t.status, t.last_activity, t.permalink,
     a.urgency, a.why, a.summary, a.suggested_action,
     lm.author_name AS last_author_name, lm.text AS last_text, lm.ts AS last_ts,
     (SELECT COUNT(*) FROM messages mc WHERE mc.thread_id = t.id) AS message_count
   FROM threads t
   LEFT JOIN analyses a ON a.thread_id = t.id
   LEFT JOIN messages lm ON lm.id = (
     SELECT m2.id FROM messages m2 WHERE m2.thread_id = t.id
     ORDER BY CAST(m2.ts AS REAL) DESC LIMIT 1
   )
   ORDER BY
     CASE a.urgency WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END ASC,
     CAST(t.last_activity AS REAL) DESC`,
);

const stmtThreadById = db.prepare('SELECT * FROM threads WHERE id = ?');
const stmtMessagesForThread = db.prepare(
  'SELECT * FROM messages WHERE thread_id = ? ORDER BY CAST(ts AS REAL) ASC',
);
const stmtAnalysisForThread = db.prepare('SELECT * FROM analyses WHERE thread_id = ?');
const stmtSetStatus = db.prepare('UPDATE threads SET status = ? WHERE id = ?');

// ---------- helpers ----------

export function findThread(
  workspace: string,
  channelId: string,
  threadTs: string,
): ThreadRow | undefined {
  return stmtFindThread.get(workspace, channelId, threadTs) as ThreadRow | undefined;
}

/**
 * Insert-or-get for a thread key.
 *
 * Callers necessarily do async work (channel name / permalink lookups) between "no such
 * thread" and this call, so two messages arriving together for the same new thread both
 * reach here. The insert is a no-op for the loser, which then reads the winner's row —
 * so its message still lands instead of dying on a UNIQUE violation. Socket Mode never
 * redelivers, so a dropped message here is lost forever.
 */
export function insertThread(t: {
  workspace: string;
  teamName: string | null;
  channelId: string;
  channelName: string | null;
  threadTs: string;
  kind: 'dm' | 'mention';
  lastActivity: string;
  permalink: string | null;
}): { id: number; created: boolean } {
  const res = stmtInsertThread.run(
    t.workspace,
    t.teamName,
    t.channelId,
    t.channelName,
    t.threadTs,
    t.kind,
    t.lastActivity,
    t.permalink,
  );
  if (res.changes > 0) return { id: Number(res.lastInsertRowid), created: true };

  const existing = findThread(t.workspace, t.channelId, t.threadTs);
  if (existing === undefined) {
    // Only reachable if the row vanished between the conflict and this read.
    throw new Error(
      `insertThread: conflict on (${t.workspace}, ${t.channelId}, ${t.threadTs}) but no row found`,
    );
  }
  return { id: existing.id, created: false };
}

/** New activity from someone else: mark unread, and move last_activity forward only. */
export function markThreadActive(threadId: number, ts: string): void {
  stmtMarkActive.run(ts, ts, threadId);
}

/** Activity from myself: move last_activity forward only, leave status alone. */
export function touchThreadActivity(threadId: number, ts: string): void {
  stmtTouchActivity.run(ts, ts, threadId);
}

/**
 * Demote a freshly-created thread to 'seen' — used by the catch-up sweep when everything
 * it found there is older than the moment we started watching (see WATCH-START RULE
 * below). Only ever touches a 'new' row, so a thread the user has already read or
 * finished with is never dragged backwards.
 */
export function markThreadSeenIfNew(threadId: number): boolean {
  return stmtSeenIfNew.run(threadId).changes > 0;
}

/**
 * Store a message. Returns false when we already had it — Socket Mode can redeliver an
 * unacked event and the catch-up sweep re-reads windows on purpose, and neither of those
 * should re-open a thread the user already dealt with.
 */
export function insertMessage(m: {
  threadId: number;
  ts: string;
  authorId: string | null;
  authorName: string | null;
  text: string | null;
  raw: string | null;
}): boolean {
  const res = stmtInsertMessage.run(
    m.threadId,
    m.ts,
    m.authorId,
    m.authorName,
    m.text,
    m.raw,
  );
  return res.changes > 0;
}

/** Fill in a channel name we could not resolve when the thread was first seen. */
export function setThreadChannelName(threadId: number, channelName: string): void {
  stmtUpdateChannelName.run(channelName, threadId);
}

/** Fill in a permalink we could not resolve when the thread was first seen. */
export function setThreadPermalink(threadId: number, permalink: string): void {
  stmtUpdatePermalink.run(permalink, threadId);
}

// ---------- edits and deletions made in Slack ----------

/**
 * Outcome of applying an edit or a deletion.
 *   null              — we never stored that message; it is not ours to correct.
 *   { changed:false } — we have it, but there was nothing left to do (already deleted).
 *   { changed:true }  — the stored transcript changed, so the analysis is now out of date.
 */
export type MessageMutation = { threadId: number; changed: boolean } | null;

function findStoredMessage(
  workspace: string,
  channelId: string,
  ts: string,
): { id: number; thread_id: number; deleted_at: string | null } | undefined {
  return stmtFindMessageByChannelTs.get(workspace, channelId, ts) as
    | { id: number; thread_id: number; deleted_at: string | null }
    | undefined;
}

/**
 * Someone edited a message in Slack. Rewrites the stored text so a card can never show
 * wording the sender has already changed.
 *
 * Deliberately does NOT touch the thread's status or last_activity: an edit is not new
 * activity, and re-opening a conversation the user has already finished with because
 * somebody fixed a typo would be worse than the stale text this fixes.
 */
export function updateMessageText(m: {
  workspace: string;
  channelId: string;
  ts: string;
  text: string | null;
  raw: string | null;
}): MessageMutation {
  const row = findStoredMessage(m.workspace, m.channelId, m.ts);
  if (row === undefined) return null;
  // A deleted message stays deleted; Slack can still emit an edit for one in odd orders.
  if (row.deleted_at !== null) return { threadId: row.thread_id, changed: false };
  stmtUpdateMessageText.run(m.text, m.raw, row.id);
  return { threadId: row.thread_id, changed: true };
}

/**
 * Someone deleted a message in Slack. The row survives (removing it would punch a hole in
 * the transcript, and could leave a card with nothing to show) but its text becomes
 * "(deleted)" and `deleted_at` is stamped. Status and last_activity are left alone, as for
 * an edit.
 */
export function markMessageDeleted(m: {
  workspace: string;
  channelId: string;
  ts: string;
}): MessageMutation {
  const row = findStoredMessage(m.workspace, m.channelId, m.ts);
  if (row === undefined) return null;
  if (row.deleted_at !== null) return { threadId: row.thread_id, changed: false };
  stmtMarkMessageDeleted.run(new Date().toISOString(), row.id);
  return { threadId: row.thread_id, changed: true };
}

/**
 * Force a re-analysis: the transcript underneath an existing analysis changed, so what
 * Claude concluded is about text that no longer exists. Clearing covered_through_ts is
 * what listThreadsNeedingAnalysis() looks for, and it leaves the old urgency/why visible
 * (marked stale in the UI) until the fresh answer lands, rather than blanking the card.
 */
export function markAnalysisStale(threadId: number): void {
  stmtStaleAnalysis.run(threadId);
}

export function getFeed(): FeedItem[] {
  const rows = stmtFeed.all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    workspace: r.workspace as string,
    team_name: (r.team_name as string | null) ?? null,
    channel_name: (r.channel_name as string | null) ?? null,
    kind: r.kind as 'dm' | 'mention',
    status: r.status as string,
    last_activity: (r.last_activity as string | null) ?? null,
    permalink: (r.permalink as string | null) ?? null,
    urgency: (r.urgency as string | null) ?? null,
    why: (r.why as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    suggested_action: (r.suggested_action as string | null) ?? null,
    last_message:
      r.last_ts != null
        ? {
            author_name: (r.last_author_name as string | null) ?? null,
            text: (r.last_text as string | null) ?? null,
            ts: r.last_ts as string,
          }
        : null,
    message_count: Number(r.message_count),
  }));
}

export function getThreadById(id: number): ThreadRow | undefined {
  return stmtThreadById.get(id) as ThreadRow | undefined;
}

export function getMessagesForThread(threadId: number): MessageRow[] {
  return stmtMessagesForThread.all(threadId) as unknown as MessageRow[];
}

export function getAnalysisForThread(threadId: number): AnalysisRow | undefined {
  return stmtAnalysisForThread.get(threadId) as AnalysisRow | undefined;
}

const VALID_STATUSES = new Set(['new', 'seen', 'done']);

export function setThreadStatus(id: number, status: 'new' | 'seen' | 'done'): boolean {
  // Belt to the trigger's braces: fail here with a clear message rather than as a SQL abort.
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`setThreadStatus: invalid status ${JSON.stringify(status)}`);
  }
  return stmtSetStatus.run(status, id).changes > 0;
}

// ---------- catch-up (backfill) state ----------

const stmtGetSyncMark = db.prepare(
  'SELECT last_ts FROM sync_state WHERE workspace = ? AND channel_id = ?',
);

const stmtSetSyncMark = db.prepare(
  `INSERT INTO sync_state (workspace, channel_id, last_ts, updated_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(workspace, channel_id) DO UPDATE SET
     last_ts = CASE
       WHEN sync_state.last_ts IS NULL OR CAST(excluded.last_ts AS REAL) > CAST(sync_state.last_ts AS REAL)
         THEN excluded.last_ts
       ELSE sync_state.last_ts END,
     updated_at = excluded.updated_at`,
);

const stmtLatestStoredTs = db.prepare(
  `SELECT m.ts AS ts FROM messages m
     JOIN threads t ON t.id = m.thread_id
    WHERE t.workspace = ? AND t.channel_id = ?
    ORDER BY CAST(m.ts AS REAL) DESC
    LIMIT 1`,
);

const stmtTrackedConversations = db.prepare(
  'SELECT DISTINCT channel_id, kind FROM threads WHERE workspace = ?',
);

const stmtRecentMentionThreads = db.prepare(
  `SELECT channel_id, thread_ts FROM threads
    WHERE workspace = ? AND kind = 'mention'
      AND last_activity IS NOT NULL
      AND CAST(last_activity AS REAL) >= CAST(? AS REAL)
    ORDER BY CAST(last_activity AS REAL) DESC
    LIMIT ?`,
);

/** Newest message ts we have already processed in this conversation, if any. */
export function getSyncMark(workspace: string, channelId: string): string | null {
  const row = stmtGetSyncMark.get(workspace, channelId) as { last_ts?: string | null } | undefined;
  return row?.last_ts ?? null;
}

/** Advance the high-water mark (never moves backwards). */
export function setSyncMark(workspace: string, channelId: string, lastTs: string): void {
  stmtSetSyncMark.run(workspace, channelId, lastTs, new Date().toISOString());
}

/** Newest message we have stored for a conversation — the seed for its first sweep. */
export function latestStoredTsForChannel(workspace: string, channelId: string): string | null {
  const row = stmtLatestStoredTs.get(workspace, channelId) as { ts?: string } | undefined;
  return row?.ts ?? null;
}

/** Conversations we already track in this workspace (cheap incremental sweep set). */
export function listTrackedConversations(workspace: string): TrackedConversation[] {
  return stmtTrackedConversations.all(workspace) as unknown as TrackedConversation[];
}

/**
 * Recently active mention threads, so the catch-up sweep can pull replies that
 * `conversations.history` never returns (it only yields top-level messages).
 */
export function listRecentMentionThreads(
  workspace: string,
  sinceTs: string,
  limit: number,
): Array<{ channel_id: string; thread_ts: string }> {
  if (limit <= 0) return [];
  return stmtRecentMentionThreads.all(workspace, sinceTs, limit) as unknown as Array<{
    channel_id: string;
    thread_ts: string;
  }>;
}

// ---------- WATCH-START RULE: what counts as "already read in Slack" ----------

/**
 * The problem this solves: the catch-up sweep imports up to three days of DMs and mentions
 * the first time it runs, and every one of them used to land as unread. Opening the app for
 * the first time therefore looked like sixteen emergencies — all of them things the user had
 * already read in Slack days earlier. Trusting that feed is impossible, and a badge that
 * counts old news is a badge you learn to ignore.
 *
 * The rule:
 *
 *   Each workspace records, once and forever, the moment we first successfully connected
 *   to it — its "watch start". A message the catch-up sweep imports that is OLDER than that
 *   moment is history: it is stored in full, but the conversation it belongs to is not
 *   marked unread. Everything else — every live message, and anything the sweep finds that
 *   arrived after we started watching (e.g. while the laptop was asleep) — is unread as
 *   before.
 *
 * "Unread" therefore means what the user assumes it means: arrived since this app has been
 * watching your Slack. The mark is set once per workspace and never moves, so a later
 * reinstall or restart cannot silently re-classify history.
 *
 * Stored in `sync_state` under a reserved channel_id. Real Slack conversation ids are
 * `C…`/`D…`/`G…`, so `__watch_start__` cannot collide with one, and nothing in the codebase
 * enumerates that table — every read is by exact (workspace, channel_id).
 */
const WATCH_START_KEY = '__watch_start__';
/** Reserved workspace name for rows that are about the app itself, not about a Slack team. */
const META_WORKSPACE = '__meta__';
/** One-time cleanup marker (see markPreWatchThreadsSeen). */
const HISTORY_SEEN_KEY = '__history_seen_v1__';

const stmtInsertReservedOnce = db.prepare(
  `INSERT INTO sync_state (workspace, channel_id, last_ts, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(workspace, channel_id) DO NOTHING`,
);

/** The recorded watch start for a workspace, in Slack ts seconds; null if never set. */
export function getWatchStart(workspace: string): number | null {
  const row = stmtGetSyncMark.get(workspace, WATCH_START_KEY) as
    | { last_ts?: string | null }
    | undefined;
  const parsed = Number.parseFloat(row?.last_ts ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Record "we started watching this workspace now", the first time only. Returns the
 * effective watch start — the previously stored one if there was one, so a restart never
 * moves it. Called from src/ingest.ts as soon as a workspace connects, before its first
 * catch-up sweep can store anything.
 */
export function ensureWatchStart(workspace: string, nowSeconds: number): number {
  stmtInsertReservedOnce.run(
    workspace,
    WATCH_START_KEY,
    nowSeconds.toFixed(6),
    new Date().toISOString(),
  );
  return getWatchStart(workspace) ?? nowSeconds;
}

/**
 * One-time cleanup for databases that were filled in before the watch-start rule existed
 * (i.e. the user's live one). Everything already in there arrived through the catch-up
 * sweep and was read in Slack days ago, so anything still marked unread whose newest
 * message predates this moment becomes 'seen'. Threads the user has already marked done,
 * and anything that arrives afterwards, are untouched.
 *
 * Runs at most once ever — the marker row is inserted in the same transaction, so a second
 * process (packaged app + dev server can run side by side) finds no work. A deliberate
 * "mark unread" the user does later can therefore never be undone by this.
 */
export interface PreWatchSeenResult {
  ran: boolean;
  backupPath: string | null;
  cutoff: number;
  newBefore: number;
  seenBefore: number;
  doneBefore: number;
  markedSeen: number;
  newAfter: number;
  seenAfter: number;
  doneAfter: number;
}

export function markPreWatchThreadsSeen(nowSeconds: number = Date.now() / 1000): PreWatchSeenResult {
  const countStatus = (s: string): number =>
    Number(
      (db.prepare('SELECT COUNT(*) AS n FROM threads WHERE status = ?').get(s) as { n?: number })
        ?.n ?? 0,
    );
  const result: PreWatchSeenResult = {
    ran: false,
    backupPath: null,
    cutoff: nowSeconds,
    newBefore: countStatus('new'),
    seenBefore: countStatus('seen'),
    doneBefore: countStatus('done'),
    markedSeen: 0,
    newAfter: 0,
    seenAfter: 0,
    doneAfter: 0,
  };
  const finish = (): PreWatchSeenResult => {
    result.newAfter = countStatus('new');
    result.seenAfter = countStatus('seen');
    result.doneAfter = countStatus('done');
    return result;
  };

  // Already done (or nothing to do) — check before taking a backup.
  if (getSyncMark(META_WORKSPACE, HISTORY_SEEN_KEY) !== null) return finish();
  if (result.newBefore === 0) {
    stmtInsertReservedOnce.run(
      META_WORKSPACE,
      HISTORY_SEEN_KEY,
      nowSeconds.toFixed(6),
      new Date().toISOString(),
    );
    return finish();
  }

  result.backupPath = backupDatabase();

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check inside the write transaction: another instance may have just done it.
    const claimed = stmtInsertReservedOnce.run(
      META_WORKSPACE,
      HISTORY_SEEN_KEY,
      nowSeconds.toFixed(6),
      new Date().toISOString(),
    ).changes;
    if (claimed > 0) {
      result.markedSeen = Number(
        db
          .prepare(
            `UPDATE threads SET status = 'seen'
              WHERE status = 'new'
                AND (last_activity IS NULL OR CAST(last_activity AS REAL) < CAST(? AS REAL))`,
          )
          .run(nowSeconds.toFixed(6)).changes,
      );
      result.ran = true;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return finish();
}

// ---------- analyzer support (appended; used by src/analyzer.ts) ----------

const stmtThreadsNeedingAnalysis = db.prepare(
  `SELECT t.* FROM threads t
   LEFT JOIN analyses a ON a.thread_id = t.id
   WHERE t.status != 'done'
     AND t.last_activity IS NOT NULL
     AND (
       a.thread_id IS NULL
       OR a.covered_through_ts IS NULL
       OR CAST(t.last_activity AS REAL) > CAST(a.covered_through_ts AS REAL)
     )
   ORDER BY CAST(t.last_activity AS REAL) DESC`,
);

/**
 * Threads whose analysis is missing or stale (activity after covered_through_ts),
 * excluding 'done' threads; newest activity first. Debounce/backoff are applied
 * by the caller (they depend on wall-clock + in-memory attempt state).
 */
export function listThreadsNeedingAnalysis(): ThreadRow[] {
  return stmtThreadsNeedingAnalysis.all() as unknown as ThreadRow[];
}

const stmtUpsertAnalysis = db.prepare(
  `INSERT INTO analyses
     (thread_id, urgency, why, summary, suggested_action, context_notes,
      covered_through_ts, analyzed_at, session_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(thread_id) DO UPDATE SET
     urgency = excluded.urgency,
     why = excluded.why,
     summary = excluded.summary,
     suggested_action = excluded.suggested_action,
     context_notes = excluded.context_notes,
     covered_through_ts = excluded.covered_through_ts,
     analyzed_at = excluded.analyzed_at,
     session_id = excluded.session_id`,
);

export function upsertAnalysis(a: {
  threadId: number;
  urgency: string;
  why: string;
  summary: string;
  suggestedAction: string;
  contextNotes: string;
  coveredThroughTs: string | null;
  analyzedAt: string;
  sessionId: string | null;
}): void {
  stmtUpsertAnalysis.run(
    a.threadId,
    a.urgency,
    a.why,
    a.summary,
    a.suggestedAction,
    a.contextNotes,
    a.coveredThroughTs,
    a.analyzedAt,
    a.sessionId,
  );
}

// ---------- migrations ----------

/**
 * DM conversations used to be keyed per message (`thread_ts = ev.thread_ts || ev.ts`),
 * so a back-and-forth with one person became a pile of one-message cards. DMs are now
 * keyed on the conversation itself (`thread_ts = channel_id`), and this folds the old
 * rows into that shape.
 *
 * Per (workspace, channel_id) with kind='dm': keep one row (the already-canonical one if
 * a previous run made it, else the lowest id), repoint every other row's messages at it,
 * drop the emptied rows and their analyses, and merge the surviving row's fields. Mention
 * threads are never touched. Idempotent: once each DM channel has exactly one row keyed
 * on the channel id, this finds no work and returns without writing anything.
 */
export interface DmMigrationResult {
  ran: boolean;
  backupPath: string | null;
  groupsMerged: number;
  threadsBefore: number;
  threadsAfter: number;
  dmThreadsBefore: number;
  dmThreadsAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  messagesDropped: number;
  analysesBefore: number;
  analysesAfter: number;
}

function countRows(sql: string): number {
  const row = db.prepare(sql).get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function backupDatabase(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${DB_PATH}.bak-${stamp}`;
  // VACUUM INTO writes a consistent snapshot including anything still in the WAL, which a
  // plain file copy of a live WAL database would miss.
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

function maxTs(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const na = Number.parseFloat(a);
  const nb = Number.parseFloat(b);
  if (!Number.isFinite(na)) return b;
  if (!Number.isFinite(nb)) return a;
  return nb > na ? b : a;
}

/** 'new' beats 'seen' beats 'done' — a merged card is as unread as its most unread part. */
function mergeStatus(statuses: string[]): string {
  if (statuses.includes('new')) return 'new';
  if (statuses.includes('seen')) return 'seen';
  return statuses[0] ?? 'new';
}

export function migrateDmThreadKeys(): DmMigrationResult {
  const result: DmMigrationResult = {
    ran: false,
    backupPath: null,
    groupsMerged: 0,
    threadsBefore: countRows('SELECT COUNT(*) AS n FROM threads'),
    threadsAfter: 0,
    dmThreadsBefore: countRows("SELECT COUNT(*) AS n FROM threads WHERE kind = 'dm'"),
    dmThreadsAfter: 0,
    messagesBefore: countRows('SELECT COUNT(*) AS n FROM messages'),
    messagesAfter: 0,
    messagesDropped: 0,
    analysesBefore: countRows('SELECT COUNT(*) AS n FROM analyses'),
    analysesAfter: 0,
  };

  // Groups that are not already "one row, keyed on the channel id".
  const stmtGroups = db.prepare(
    `SELECT workspace, channel_id,
            COUNT(*) AS n,
            SUM(CASE WHEN thread_ts = channel_id THEN 1 ELSE 0 END) AS canonical
       FROM threads
      WHERE kind = 'dm'
      GROUP BY workspace, channel_id
     HAVING n > 1 OR canonical = 0`,
  );
  type DmGroup = { workspace: string; channel_id: string; n: number; canonical: number };

  if ((stmtGroups.all() as DmGroup[]).length === 0) {
    result.threadsAfter = result.threadsBefore;
    result.dmThreadsAfter = result.dmThreadsBefore;
    result.messagesAfter = result.messagesBefore;
    result.analysesAfter = result.analysesBefore;
    return result;
  }

  result.backupPath = backupDatabase();

  const rowsOfGroup = db.prepare(
    "SELECT * FROM threads WHERE kind = 'dm' AND workspace = ? AND channel_id = ? ORDER BY id ASC",
  );
  const repoint = db.prepare('UPDATE OR IGNORE messages SET thread_id = ? WHERE thread_id = ?');
  const dropLeftoverMessages = db.prepare('DELETE FROM messages WHERE thread_id = ?');
  const dropAnalysis = db.prepare('DELETE FROM analyses WHERE thread_id = ?');
  const dropThread = db.prepare('DELETE FROM threads WHERE id = ?');
  const updateSurvivor = db.prepare(
    `UPDATE threads
        SET thread_ts = ?, channel_name = ?, permalink = ?, last_activity = ?, status = ?
      WHERE id = ?`,
  );
  const staleAnalysis = db.prepare(
    'UPDATE analyses SET covered_through_ts = NULL WHERE thread_id = ?',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read inside the write transaction: another instance of the app (packaged app +
    // dev server can run side by side) may have merged some of these already.
    for (const g of stmtGroups.all() as DmGroup[]) {
      const rows = rowsOfGroup.all(g.workspace, g.channel_id) as unknown as ThreadRow[];
      if (rows.length === 0) continue;

      const survivor = rows.find((r) => r.thread_ts === g.channel_id) ?? rows[0];
      const losers = rows.filter((r) => r.id !== survivor.id);

      let channelName = survivor.channel_name;
      let permalink = survivor.permalink;
      let lastActivity = survivor.last_activity;
      const statuses = [survivor.status];

      for (const loser of losers) {
        channelName = channelName ?? loser.channel_name;
        permalink = permalink ?? loser.permalink;
        lastActivity = maxTs(lastActivity, loser.last_activity);
        statuses.push(loser.status);

        repoint.run(survivor.id, loser.id);
        // Anything left behind collided with a message the survivor already had.
        result.messagesDropped += Number(dropLeftoverMessages.run(loser.id).changes);
        dropAnalysis.run(loser.id);
        dropThread.run(loser.id);
      }

      updateSurvivor.run(
        g.channel_id,
        channelName,
        permalink,
        lastActivity,
        mergeStatus(statuses),
        survivor.id,
      );
      // The transcript changed under any existing analysis — force a re-run.
      staleAnalysis.run(survivor.id);
      result.groupsMerged += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  result.ran = true;
  result.threadsAfter = countRows('SELECT COUNT(*) AS n FROM threads');
  result.dmThreadsAfter = countRows("SELECT COUNT(*) AS n FROM threads WHERE kind = 'dm'");
  result.messagesAfter = countRows('SELECT COUNT(*) AS n FROM messages');
  result.analysesAfter = countRows('SELECT COUNT(*) AS n FROM analyses');
  return result;
}

// Run on startup: the user never runs scripts, so an old database has to heal itself.
// A failure here (e.g. another instance holding the write lock) must never stop the app —
// the data is untouched and the next start tries again.
try {
  const migration = migrateDmThreadKeys();
  if (migration.ran) {
    console.log(
      `[db] merged ${migration.groupsMerged} DM conversation(s): ` +
        `threads ${migration.threadsBefore} → ${migration.threadsAfter}, ` +
        `messages ${migration.messagesBefore} → ${migration.messagesAfter}` +
        (migration.messagesDropped > 0 ? ` (${migration.messagesDropped} duplicates dropped)` : '') +
        `; backup: ${migration.backupPath}`,
    );
  }
} catch (err) {
  console.warn(`[db] DM conversation migration skipped: ${(err as Error).message}`);
}

// One-time: everything already in an existing database came from the catch-up sweep before
// the watch-start rule existed, so it is history, not sixteen emergencies. Same contract as
// above — never fatal, and it can only ever run once per database.
try {
  const seenFix = markPreWatchThreadsSeen();
  if (seenFix.ran) {
    console.log(
      `[db] first-run tidy-up: ${seenFix.markedSeen} conversation(s) that were already read ` +
        `in Slack marked as read (unread ${seenFix.newBefore} → ${seenFix.newAfter}, ` +
        `read ${seenFix.seenBefore} → ${seenFix.seenAfter}, done ${seenFix.doneBefore} → ` +
        `${seenFix.doneAfter}); backup: ${seenFix.backupPath}`,
    );
  }
} catch (err) {
  console.warn(`[db] first-run tidy-up skipped: ${(err as Error).message}`);
}
