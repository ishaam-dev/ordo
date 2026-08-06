/**
 * Fixture helpers: a *second* SQLite connection to the same temp file, used to seed rows
 * and to assert on them with raw SQL. Reading through a separate handle keeps the
 * assertions honest — they check what is actually on disk, not what src/db.ts returned.
 */
import { DatabaseSync } from 'node:sqlite';
import { TEST_DB_PATH } from './env.js';

let handle: DatabaseSync | null = null;

/** Raw handle to the temp database. Open it only after `src/db.ts` has created the schema. */
export function raw(): DatabaseSync {
  if (handle === null) {
    handle = new DatabaseSync(TEST_DB_PATH);
    handle.exec('PRAGMA busy_timeout = 5000;');
  }
  return handle;
}

/**
 * Empty every table this app owns, so each test starts from a known state.
 * `chat_sessions`/`chat_messages` only exist once src/chat.ts has been imported.
 */
export function resetDb(): void {
  const db = raw();
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  for (const table of [
    'chat_messages',
    'chat_sessions',
    'analyses',
    'messages',
    'threads',
    'sync_state',
  ]) {
    if (present.has(table)) db.exec(`DELETE FROM ${table}`);
  }
  // sqlite_sequence is deliberately NOT reset: row ids must keep increasing across tests
  // so that module-level, id-keyed state in src/analyzer.ts (the failure backoff map)
  // cannot leak from one test into the next.
}

export interface ThreadFixture {
  workspace?: string;
  team_name?: string | null;
  channel_id?: string;
  channel_name?: string | null;
  thread_ts?: string;
  kind?: 'dm' | 'mention';
  status?: string;
  last_activity?: string | null;
  permalink?: string | null;
}

/** Insert a thread row directly (bypassing src/db.ts) and return its id. */
export function seedThread(t: ThreadFixture = {}): number {
  const res = raw()
    .prepare(
      `INSERT INTO threads
         (workspace, team_name, channel_id, channel_name, thread_ts, kind, status, last_activity, permalink)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.workspace ?? 'A',
      'team_name' in t ? t.team_name : 'Team A',
      t.channel_id ?? 'C1',
      'channel_name' in t ? t.channel_name : 'general',
      t.thread_ts ?? '1000.000100',
      t.kind ?? 'mention',
      t.status ?? 'new',
      'last_activity' in t ? t.last_activity : '1000.000100',
      t.permalink ?? null,
    );
  return Number(res.lastInsertRowid);
}

export interface MessageFixture {
  thread_id: number;
  ts?: string;
  author_id?: string | null;
  author_name?: string | null;
  text?: string | null;
  raw?: string | null;
}

export function seedMessage(m: MessageFixture): number {
  const res = raw()
    .prepare(
      'INSERT INTO messages (thread_id, ts, author_id, author_name, text, raw) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      m.thread_id,
      m.ts ?? '1000.000100',
      'author_id' in m ? m.author_id : 'U_OTHER',
      'author_name' in m ? m.author_name : 'Other Person',
      'text' in m ? m.text : 'hello',
      m.raw ?? null,
    );
  return Number(res.lastInsertRowid);
}

export function threadRow(id: number): Record<string, unknown> | undefined {
  return raw().prepare('SELECT * FROM threads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

export function messageRows(threadId: number): Array<Record<string, unknown>> {
  return raw()
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY CAST(ts AS REAL) ASC')
    .all(threadId) as Array<Record<string, unknown>>;
}

export function countRows(table: string): number {
  const row = raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
  return Number(row?.n ?? 0);
}
