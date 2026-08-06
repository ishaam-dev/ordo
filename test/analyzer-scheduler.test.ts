/**
 * CHARACTERIZATION — src/analyzer.ts scheduler *decisions*: the "needs analysis"
 * predicate, the 45s debounce, the 5-minute failure backoff, the forced-reanalysis
 * queue jump and the bounded-pool rule.
 *
 * BEHAVIOUR CHANGE, DELIBERATE: this file used to assert "strictly one analysis at a
 * time". The analyzer now runs a bounded pool, so that test has been rewritten (not
 * deleted, not weakened) to assert the invariants that replaced it:
 *   - at most COPILOT_ANALYZER_CONCURRENCY analyses in flight, however many ticks fire;
 *   - never two analyses of the same thread.
 * The narrower serial guarantee is still pinned, at COPILOT_ANALYZER_CONCURRENCY=1, in
 * test/analyzer-concurrency.test.ts.
 *
 * NO AI HARNESS IS EVER REACHED. Every thread seeded here deliberately has zero
 * messages, so `analyzeThread()` throws "thread has no messages" before it can build a
 * prompt or call `query()`. That is what makes it safe to drive the real `tick()`.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, seedThread, countRows } from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);
const { pickNext, tick, requestReanalysis } = await import('../src/analyzer.js');
const { analyzerHealth } = await import('../src/health.js');
const { ANALYZER_CONCURRENCY } = await import('../src/config.js');

const now = (): number => Date.now() / 1000;
const ts = (secondsAgo: number): string => (now() - secondsAgo).toFixed(6);

/** Let pending microtasks + timers (including a scheduled tick) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
}

before(() => {
  resetDb();
});

beforeEach(async () => {
  await settle();
  resetDb();
  await settle();
  // Safety net for this whole file: an analysis of a message-less thread can never reach
  // an AI harness. If a test ever seeds a message, that guarantee is gone.
  assert.equal(countRows('messages'), 0);
});

// ---------------------------------------------------------------------------
// the "needs analysis" predicate (src/db.ts listThreadsNeedingAnalysis)
// ---------------------------------------------------------------------------

test('needs analysis: a thread with no analysis row at all', () => {
  const id = seedThread({ last_activity: ts(100) });
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id]);
});

test('needs analysis: covered_through_ts NULL means stale (that is how edits re-queue)', () => {
  const id = seedThread({ last_activity: ts(100) });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: null,
    analyzedAt: new Date().toISOString(),
    sessionId: 'sess-1',
  });
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id]);
});

test('needs analysis: covered_through_ts == last_activity means up to date', () => {
  const at = ts(100);
  const id = seedThread({ last_activity: at });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: at,
    analyzedAt: new Date().toISOString(),
    sessionId: 'sess-1',
  });
  assert.deepEqual(db.listThreadsNeedingAnalysis(), []);
});

test('needs analysis: last_activity > covered_through_ts means stale', () => {
  const id = seedThread({ last_activity: ts(100) });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: ts(500), // analysis covered an older state of the thread
    analyzedAt: new Date().toISOString(),
    sessionId: 'sess-1',
  });
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id]);
  // …and comparison is numeric, not lexicographic: 999.0 < 1000.0 even though "999" > "1"
  resetDb();
  const id2 = seedThread({ last_activity: '1000.000000' });
  db.upsertAnalysis({
    threadId: id2,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: '999.000000',
    analyzedAt: new Date().toISOString(),
    sessionId: null,
  });
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id2]);
});

test("needs analysis: status 'done' is excluded, 'new' and 'seen' are not", () => {
  const done = seedThread({ channel_id: 'C1', thread_ts: '1', status: 'done', last_activity: ts(100) });
  const seen = seedThread({ channel_id: 'C2', thread_ts: '2', status: 'seen', last_activity: ts(200) });
  const fresh = seedThread({ channel_id: 'C3', thread_ts: '3', status: 'new', last_activity: ts(300) });
  const ids = db.listThreadsNeedingAnalysis().map((t) => t.id);
  assert.equal(ids.includes(done), false);
  assert.deepEqual(ids, [seen, fresh]); // newest activity first
});

test('needs analysis: a thread with no last_activity is never eligible', () => {
  seedThread({ last_activity: null });
  assert.deepEqual(db.listThreadsNeedingAnalysis(), []);
});

test('needs analysis: ordered by last_activity, newest first', () => {
  const old = seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: ts(9_000) });
  const mid = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(5_000) });
  const recent = seedThread({ channel_id: 'C3', thread_ts: '3', last_activity: ts(100) });
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [recent, mid, old]);
});

// ---------------------------------------------------------------------------
// pickNext: debounce
// ---------------------------------------------------------------------------

test('pickNext: a thread must be quiet for 45s before it is picked up', () => {
  const noisy = seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: ts(5) });
  assert.equal(pickNext(), null, 'a thread active 5s ago is still settling');

  const quiet = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(60) });
  assert.equal(pickNext()?.id, quiet);
  assert.notEqual(quiet, noisy);
});

test('pickNext: the debounce boundary is 45 seconds', () => {
  const id = seedThread({ last_activity: ts(44) });
  assert.equal(pickNext(), null);
  db.getThreadById(id); // (no-op read; keeps the id used)
  resetDb();
  const ok = seedThread({ last_activity: ts(46) });
  assert.equal(pickNext()?.id, ok);
});

test('pickNext: a thread whose last_activity does not parse is never eligible', () => {
  seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: 'not-a-number' });
  assert.equal(pickNext(), null);
  const good = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(100) });
  assert.equal(pickNext()?.id, good);
});

test('pickNext: among eligible threads the most recently active wins', () => {
  seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: ts(9_000) });
  const recent = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(60) });
  assert.equal(pickNext()?.id, recent);
});

// ---------------------------------------------------------------------------
// forced re-analysis (POST /api/thread/:id/reanalyze)
// ---------------------------------------------------------------------------

test('requestReanalysis: rejects ids that are not positive integers', () => {
  assert.deepEqual(requestReanalysis(0), { ok: false, reason: 'unknown_thread' });
  assert.deepEqual(requestReanalysis(-1), { ok: false, reason: 'unknown_thread' });
  assert.deepEqual(requestReanalysis(1.5), { ok: false, reason: 'unknown_thread' });
  assert.deepEqual(requestReanalysis(Number.NaN), { ok: false, reason: 'unknown_thread' });
});

test('requestReanalysis: rejects an id that is not in the database', () => {
  assert.deepEqual(requestReanalysis(999_999), { ok: false, reason: 'unknown_thread' });
});

test('a forced thread jumps the queue and skips the debounce', async () => {
  const quiet = seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: ts(600) });
  const noisy = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(1) });

  const res = requestReanalysis(noisy);
  assert.equal(res.ok, true);
  // Picked before the older, already-eligible thread, and in spite of its own debounce.
  assert.equal(pickNext()?.id, noisy);
  // One attempt per request: the force is consumed, so the normal rules apply again.
  assert.equal(pickNext()?.id, quiet);
  await settle();
});

test('a forced thread is offered even with no last_activity at all', async () => {
  const id = seedThread({ last_activity: null });
  assert.equal(pickNext(), null);
  assert.equal(requestReanalysis(id).ok, true);
  assert.equal(pickNext()?.id, id);
  await settle();
});

test('requestReanalysis reports the queue depth (threads needing analysis ∪ forced)', async () => {
  seedThread({ channel_id: 'C1', thread_ts: '1', last_activity: ts(600) });
  const b = seedThread({ channel_id: 'C2', thread_ts: '2', last_activity: ts(600) });
  const res = requestReanalysis(b);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.queued, 2);
  assert.equal(analyzerHealth().queued, 2);
  pickNext(); // consume the force so the scheduled tick finds nothing forced
  await settle();
});

// ---------------------------------------------------------------------------
// tick(): the bounded pool and the failure backoff
// ---------------------------------------------------------------------------

/**
 * REPLACES 'tick: strictly one analysis at a time'.
 *
 * The old rule was `if (inFlight) return`, and this test asserted that three tick() calls
 * produced exactly one attempt. The scheduler is now a bounded pool, so the guarantee it
 * offers is different — and this is the test that says what the new one is. It is
 * deliberately stronger than "not more than one": it pins the cap, pins that extra ticks
 * cannot widen it, and pins that no thread is ever run twice at once.
 */
test('tick: at most COPILOT_ANALYZER_CONCURRENCY analyses at once, never two of one thread', async () => {
  const seeded: number[] = [];
  for (let i = 0; i < ANALYZER_CONCURRENCY + 3; i++) {
    seeded.push(seedThread({ channel_id: `C${i}`, thread_ts: String(i), last_activity: ts(600 + i) }));
  }
  assert.ok(seeded.length > ANALYZER_CONCURRENCY, 'more work than the pool can hold at once');
  const before = analyzerHealth().consecutiveFailures;

  // One tick fills the pool — and stops there, even though more threads are eligible.
  tick();
  const filled = analyzerHealth().currentThreadIds;
  assert.equal(filled.length, ANALYZER_CONCURRENCY, 'the pool is filled to its limit, no further');
  assert.ok(filled.length < seeded.length, 'and the limit really did hold work back');
  assert.equal(new Set(filled).size, filled.length, 'no thread is in flight twice');

  // Extra ticks while the pool is full cannot widen it (the old `if (inFlight) return`).
  tick();
  tick();
  assert.deepEqual(analyzerHealth().currentThreadIds, filled, 'a full pool ignores further ticks');

  await settle();

  // Every seeded thread is attempted exactly once: the pool drains the backlog rather
  // than dropping it, and the failure backoff stops any of them being retried.
  assert.equal(
    analyzerHealth().consecutiveFailures - before,
    seeded.length,
    'each eligible thread was analyzed exactly once',
  );
  assert.deepEqual(analyzerHealth().currentThreadIds, [], 'and the pool is empty again');
});

test('tick: a failed thread is not retried for 5 minutes, and reanalyze clears that', async () => {
  const id = seedThread({ last_activity: ts(600) });

  assert.equal(pickNext()?.id, id, 'eligible before the attempt');
  tick();
  await settle();
  assert.equal(analyzerHealth().state, 'error');

  assert.equal(pickNext(), null, 'backed off after a failure');

  // POST /api/thread/:id/reanalyze drops the backoff…
  assert.equal(requestReanalysis(id).ok, true);
  assert.equal(pickNext()?.id, id);
  await settle();
  // …but the failed attempt it triggers re-arms the backoff.
  assert.equal(pickNext(), null);
});

test('tick: does nothing when nothing is eligible, and reports a zero backlog', async () => {
  const before = analyzerHealth().consecutiveFailures;
  seedThread({ last_activity: ts(1) }); // still inside the debounce window
  tick();
  await settle();
  assert.equal(analyzerHealth().consecutiveFailures, before);
  assert.equal(analyzerHealth().queued, 1); // queued counts staleness, not eligibility
});

// ---------------------------------------------------------------------------
// covered_through_ts semantics, end to end through the store
// ---------------------------------------------------------------------------

test('covered_through_ts: a reply landing after an analysis re-queues the thread', () => {
  const id = seedThread({ last_activity: '1000.000100' });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: '1000.000100', // read at the START of the run
    analyzedAt: new Date().toISOString(),
    sessionId: 'sess-1',
  });
  assert.deepEqual(db.listThreadsNeedingAnalysis(), []);

  db.markThreadActive(id, '1000.000200'); // a reply arrives
  assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id]);

  // The stale analysis stays visible (urgency/why are not blanked) until a new one lands.
  assert.equal(db.getAnalysisForThread(id)?.urgency, 'P2');
});

test('upsertAnalysis overwrites every field of an existing row, including the session id', () => {
  const id = seedThread({ last_activity: '1000.000100' });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P0',
    why: 'first',
    summary: 's1',
    suggestedAction: 'a1',
    contextNotes: 'n1',
    coveredThroughTs: '1000.000100',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'sess-1',
  });
  db.upsertAnalysis({
    threadId: id,
    urgency: 'P3',
    why: 'second',
    summary: 's2',
    suggestedAction: 'a2',
    contextNotes: '',
    coveredThroughTs: '1000.000200',
    analyzedAt: '2026-01-02T00:00:00.000Z',
    sessionId: 'sess-2',
  });
  const a = db.getAnalysisForThread(id);
  assert.equal(countRows('analyses'), 1);
  assert.deepEqual(
    {
      urgency: a?.urgency,
      why: a?.why,
      covered: a?.covered_through_ts,
      session: a?.session_id,
      at: a?.analyzed_at,
    },
    {
      urgency: 'P3',
      why: 'second',
      covered: '1000.000200',
      session: 'sess-2',
      at: '2026-01-02T00:00:00.000Z',
    },
  );
});
