/**
 * Child-process probe for the analyzer pool: seed a backlog, call tick() ONCE, and print
 * what the scheduler did with it.
 *
 * In its own process because COPILOT_ANALYZER_CONCURRENCY is read once, at import (like
 * PORT), so a single test process cannot observe two different pool sizes.
 *
 * NO AI HARNESS IS EVER REACHED: every seeded thread has zero messages, so
 * `analyzeThread()` throws "thread has no messages" before it can build a prompt. That is
 * what makes it safe to drive the real tick().
 *
 * Refuses to run without an explicit COPILOT_DB_PATH so it can never touch the live db.
 */
if ((process.env.COPILOT_DB_PATH ?? '') === '') {
  throw new Error('REFUSING TO RUN: set COPILOT_DB_PATH to a throwaway database first');
}
process.env.TZ = 'UTC';

const backlog = Number(process.env.BURST_THREADS ?? '6');

const db = await import('../../src/db.js');
if (db.DB_PATH !== process.env.COPILOT_DB_PATH) {
  throw new Error(`REFUSING TO RUN: src/db.ts opened ${db.DB_PATH}`);
}
const { tick } = await import('../../src/analyzer.js');
const { analyzerHealth } = await import('../../src/health.js');
const { ANALYZER_CONCURRENCY } = await import('../../src/config.js');

const { DatabaseSync } = await import('node:sqlite');
const raw = new DatabaseSync(db.DB_PATH);
for (const table of ['analyses', 'messages', 'threads']) raw.exec(`DELETE FROM ${table}`);

// Well past the 45s debounce, and message-less so each analysis fails immediately.
const quiet = (Date.now() / 1000 - 600).toFixed(6);
for (let i = 0; i < backlog; i++) {
  raw
    .prepare(
      `INSERT INTO threads (workspace, team_name, channel_id, channel_name, thread_ts, kind, status, last_activity, permalink)
       VALUES ('A', 'Team A', ?, 'general', ?, 'mention', 'new', ?, NULL)`,
    )
    .run(`CB${i}`, `900${i}.000100`, quiet);
}

const before = analyzerHealth().consecutiveFailures;
tick(); // exactly one heartbeat
const afterOneTick = analyzerHealth().currentThreadIds.length;

// Let every started run, and anything they trigger, finish.
for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1));

console.log(
  JSON.stringify({
    configured: ANALYZER_CONCURRENCY,
    backlog,
    /** How many analyses a single tick() put in flight. */
    startedByOneTick: afterOneTick,
    /** How many ran in total afterwards — i.e. whether a freed slot refills itself. */
    attemptsAfterOneTick: analyzerHealth().consecutiveFailures - before,
    idleAtEnd: analyzerHealth().currentThreadIds.length === 0,
  }),
);
process.exit(0);
