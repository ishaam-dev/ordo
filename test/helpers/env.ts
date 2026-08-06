/**
 * Test isolation. MUST be the first import of every test file, and every `src/*` module
 * must be imported *dynamically* afterwards — `src/db.ts` opens its database and
 * `src/config.ts` reads `.env` at module load, so both have to be neutralised first.
 *
 * What this guarantees:
 *   - the database is a fresh file in a per-process temp directory, never `data.db`
 *   - dotenv is pointed at a path that does not exist, so the real `.env` is never read
 *     and no Slack token can enter the test process
 *   - the temp directory (db + -wal + -shm + any VACUUM INTO backup) is removed on exit
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fixed timezone so the `[YYYY-MM-DD HH:MM]` transcript stamps are the same everywhere.
// Set before anything constructs a Date.
process.env.TZ = 'UTC';

export const TMP_DIR: string = mkdtempSync(path.join(os.tmpdir(), 'slack-copilot-test-'));
export const TEST_DB_PATH: string = path.join(TMP_DIR, 'test.db');

// src/db.ts: `COPILOT_DB_PATH` overrides the live `data.db`.
process.env.COPILOT_DB_PATH = TEST_DB_PATH;

// src/config.ts imports 'dotenv/config'. DOTENV_CONFIG_PATH makes it read a file that does
// not exist, so the user's real tokens never land in process.env here.
process.env.DOTENV_CONFIG_PATH = path.join(TMP_DIR, 'absent.env');
process.env.DOTENV_CONFIG_QUIET = 'true';

// Belt and braces: nothing Slack-shaped may be inherited from the parent shell either.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SLACK_')) delete process.env[key];
}
delete process.env.COPILOT_REPLY_DRYRUN;
delete process.env.ANALYZER_DISABLED;
delete process.env.PORT;

process.on('exit', () => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * Refuse to run against anything but the temp file. A test that quietly pointed at the
 * user's live `data.db` would be far worse than a test that fails to start.
 */
export function assertIsolated(dbPath: string): void {
  if (dbPath !== TEST_DB_PATH) {
    throw new Error(
      `REFUSING TO RUN: src/db.ts opened ${dbPath}, expected the temp database ${TEST_DB_PATH}`,
    );
  }
}
