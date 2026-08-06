import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = path.join(projectRoot, 'data.db');

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

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
`);

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

// ---------- prepared statements ----------

const stmtFindThread = db.prepare(
  'SELECT * FROM threads WHERE workspace = ? AND channel_id = ? AND thread_ts = ?',
);

const stmtInsertThread = db.prepare(
  `INSERT INTO threads (workspace, team_name, channel_id, channel_name, thread_ts, kind, status, last_activity, permalink)
   VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
);

const stmtMarkActive = db.prepare(
  "UPDATE threads SET status = 'new', last_activity = ? WHERE id = ?",
);

const stmtTouchActivity = db.prepare('UPDATE threads SET last_activity = ? WHERE id = ?');

const stmtInsertMessage = db.prepare(
  `INSERT OR IGNORE INTO messages (thread_id, ts, author_id, author_name, text, raw)
   VALUES (?, ?, ?, ?, ?, ?)`,
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

export function insertThread(t: {
  workspace: string;
  teamName: string | null;
  channelId: string;
  channelName: string | null;
  threadTs: string;
  kind: 'dm' | 'mention';
  lastActivity: string;
  permalink: string | null;
}): number {
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
  return Number(res.lastInsertRowid);
}

/** New activity from someone else: bump last_activity and reset status to 'new'. */
export function markThreadActive(threadId: number, ts: string): void {
  stmtMarkActive.run(ts, threadId);
}

/** Activity from myself: bump last_activity only, leave status alone. */
export function touchThreadActivity(threadId: number, ts: string): void {
  stmtTouchActivity.run(ts, threadId);
}

export function insertMessage(m: {
  threadId: number;
  ts: string;
  authorId: string | null;
  authorName: string | null;
  text: string | null;
  raw: string | null;
}): void {
  stmtInsertMessage.run(m.threadId, m.ts, m.authorId, m.authorName, m.text, m.raw);
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

export function setThreadStatus(id: number, status: 'new' | 'seen' | 'done'): boolean {
  return stmtSetStatus.run(status, id).changes > 0;
}
