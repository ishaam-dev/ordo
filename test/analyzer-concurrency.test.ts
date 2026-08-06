/**
 * THE BOUNDED POOL — src/analyzer.ts scheduler concurrency.
 *
 * The analyzer used to run `let inFlight = false; if (inFlight) return;` — strictly one
 * analysis at a time. Measured on real data that made a 16-thread backlog take twelve
 * minutes to clear, which is the exact situation this app exists to handle (the laptop
 * was shut; sixteen threads are waiting). It now runs a bounded pool instead.
 *
 * What must stay true, and is asserted below:
 *   1. never more than COPILOT_ANALYZER_CONCURRENCY analyses in flight, whatever arrives;
 *   2. never two analyses of the SAME thread — they would race on one `analyses` row;
 *   3. COPILOT_ANALYZER_CONCURRENCY=1 is the old scheduler, exactly;
 *   4. a `rate_limit` or `budget` failure narrows the pool toward 1 and it recovers slowly;
 *   5. a forced re-analysis still jumps the queue.
 *
 * Everything here drives the REAL tick()/pickNext()/analyzeThread() path through the
 * fake-provider seam (test/helpers/fake-harness.ts). Nothing talks to Slack, to a model,
 * or to any binary.
 */
import './helpers/env.js';
import { assertIsolated, TEST_DB_PATH } from './helpers/env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, seedThread, seedMessage } from './helpers/fixtures.js';
import { makeFakeHarness, verdictEvents } from './helpers/fake-harness.js';
import type { HarnessProvider, HarnessRequest } from '../src/harness/types.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);

const harness = await import('../src/harness/index.js');
const probe = await import('../src/harness/probe.js');
const analyzer = await import('../src/analyzer.js');
const { analyzerHealth } = await import('../src/health.js');
const { ANALYZER_CONCURRENCY, MAX_ANALYZER_CONCURRENCY, analyzerConcurrencyFrom } = await import(
  '../src/config.js'
);
const { ClassifiedError } = await import('../src/harness/types.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = ANALYZER_CONCURRENCY;

const now = (): number => Date.now() / 1000;
const ts = (secondsAgo: number): string => (now() - secondsAgo).toFixed(6);

/** Let pending microtasks and zero-delay timers (including a scheduled tick) run. */
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 1));
}

async function reach(predicate: () => boolean, turns = 400): Promise<boolean> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return false;
}

async function until(predicate: () => boolean, what = 'condition'): Promise<void> {
  if (!(await reach(predicate))) assert.fail(`${what} never became true`);
}

/** Wait for the pool to be genuinely empty AND to stay empty for a few turns. */
async function quiet(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (analyzerHealth().currentThreadIds.length === 0) {
      // A finished run schedules its refill on the next macrotask, so "empty right now"
      // is not the same as "done" — only empty-and-still-empty is.
      await settle(3);
      if (analyzerHealth().currentThreadIds.length === 0) return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A thread that is eligible right now: past the debounce, with a message to analyze. */
function eligibleThread(tag: string, secondsAgo = 600): number {
  const id = seedThread({ channel_id: `C_${tag}`, thread_ts: tag, last_activity: ts(secondsAgo) });
  seedMessage({ thread_id: id, text: `work item ${tag}` });
  return id;
}

/**
 * A provider that parks every run until the test lets it go. This is what makes the pool
 * observable: without it every fake analysis finishes inside a microtask and nothing ever
 * overlaps, so a broken cap would still look fine.
 */
interface Gated {
  provider: HarnessProvider;
  requests: HarnessRequest[];
  readonly parked: number;
  releaseOne(): void;
  releaseAll(): void;
}

function gatedHarness(id: string): Gated {
  const waiters: Array<() => void> = [];
  let openForever = false;
  const fake = makeFakeHarness({
    id,
    script: async () => {
      if (!openForever) await new Promise<void>((resolve) => waiters.push(resolve));
      return verdictEvents(`sess-${id}`);
    },
  });
  return {
    provider: fake.provider,
    requests: fake.requests,
    get parked(): number {
      return waiters.length;
    },
    releaseOne(): void {
      waiters.shift()?.();
    },
    releaseAll(): void {
      openForever = true;
      while (waiters.length > 0) waiters.shift()?.();
    },
  };
}

/**
 * NO TEST IN THIS FILE MAY EVER RESTORE THE REAL HARNESS.
 *
 * Unlike test/analyzer-scheduler.test.ts, the threads here have messages, so
 * `analyzeThread()` runs all the way to `provider.run()`. A pool slot freeing schedules
 * its own tick(), so a test that ended with `setActiveHarness(null)` could have that
 * deferred tick spawn a REAL Claude Code process against test fixtures. Every teardown
 * therefore parks the scheduler on this inert fake instead of on null, and beforeEach
 * asserts that nothing put the real one back.
 */
const idleProvider = makeFakeHarness({ id: 'idle-fake', script: verdictEvents('sess-idle') }).provider;
await probe.ensureSafetyProof(idleProvider, {});
harness.setActiveHarness(idleProvider);

beforeEach(async () => {
  // Swap first, drain second, wipe third:
  //  - swap, so any tick a finishing run schedules lands on the inert fake;
  //  - drain BEFORE wiping, because a run whose thread row vanishes mid-flight fails with
  //    a foreign-key error and would contaminate the next test's expectations.
  harness.setActiveHarness(idleProvider);
  await quiet();
  assert.notEqual(harness.activeHarness().identity.id, 'claude-code', 'the real harness is never active here');
  analyzer.resetConcurrencyBackoff();
  resetDb();
  await settle();
});

// ---------------------------------------------------------------------------
// the configuration knob
// ---------------------------------------------------------------------------

test('COPILOT_ANALYZER_CONCURRENCY: default, parsing, and a hard ceiling', () => {
  assert.equal(analyzerConcurrencyFrom(undefined), 3, 'the measured default');
  assert.equal(analyzerConcurrencyFrom(''), 3);
  assert.equal(analyzerConcurrencyFrom('   '), 3);
  assert.equal(ANALYZER_CONCURRENCY, 3, 'unset in this process');

  assert.equal(analyzerConcurrencyFrom('1'), 1);
  assert.equal(analyzerConcurrencyFrom(' 2 '), 2);
  assert.equal(analyzerConcurrencyFrom('4'), 4);

  // Anything unparseable falls back to the default, exactly as PORT does.
  for (const bad of ['0', '-1', 'abc', '2.5', 'NaN', 'Infinity']) {
    assert.equal(analyzerConcurrencyFrom(bad), 3, `COPILOT_ANALYZER_CONCURRENCY=${bad}`);
  }
});

test('the ceiling is hard: sixteen simultaneous harness processes are unreachable', () => {
  assert.equal(MAX_ANALYZER_CONCURRENCY, 4);
  // A number above the ceiling is CLAMPED, not rejected back to the default: "16" is a
  // legible intent that simply may not be honoured.
  for (const greedy of ['5', '8', '16', '100', '999999']) {
    assert.equal(analyzerConcurrencyFrom(greedy), MAX_ANALYZER_CONCURRENCY, greedy);
  }
  assert.ok(ANALYZER_CONCURRENCY <= MAX_ANALYZER_CONCURRENCY);
});

// ---------------------------------------------------------------------------
// 1. the cap holds under a burst
// ---------------------------------------------------------------------------

test('a burst never puts more than the configured number of analyses in flight', async () => {
  const ids: number[] = [];
  for (let i = 0; i < N + 3; i++) ids.push(eligibleThread(`burst${i}`, 600 + i));
  const gate = gatedHarness('burst-fake');
  await probe.ensureSafetyProof(gate.provider, {});
  harness.setActiveHarness(gate.provider);
  try {
    analyzer.tick();
    await until(() => gate.parked === N, 'the pool fills');

    assert.equal(gate.requests.length, N, 'one tick fills the pool and stops');
    assert.equal(analyzerHealth().currentThreadIds.length, N);

    // More ticks, and more work arriving, cannot widen the pool.
    analyzer.tick();
    analyzer.tick();
    eligibleThread('burst-late');
    analyzer.tick();
    await settle();
    assert.equal(gate.requests.length, N, 'a full pool refuses every further tick');
    assert.equal(analyzerHealth().currentThreadIds.length, N);

    // One slot frees ⇒ exactly one more starts, without waiting for a heartbeat.
    gate.releaseOne();
    await until(() => gate.requests.length === N + 1, 'the freed slot is refilled');
    await settle();
    assert.equal(gate.requests.length, N + 1, 'a freed slot takes exactly one more thread');
    assert.equal(analyzerHealth().currentThreadIds.length, N);

    // …and the whole backlog drains, N at a time.
    gate.releaseAll();
    await until(() => gate.requests.length === ids.length + 1, 'the backlog drains');
    await quiet();
    assert.equal(gate.requests.length, ids.length + 1, 'every thread was analyzed, none twice');
    assert.deepEqual(analyzerHealth().currentThreadIds, []);
    assert.equal(db.listThreadsNeedingAnalysis().length, 0, 'and the backlog is empty');
  } finally {
    gate.releaseAll();
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

test('every thread in a burst is analyzed exactly once', async () => {
  const ids: number[] = [];
  for (let i = 0; i < N + 4; i++) ids.push(eligibleThread(`once${i}`, 600 + i));
  const gate = gatedHarness('once-fake');
  await probe.ensureSafetyProof(gate.provider, {});
  harness.setActiveHarness(gate.provider);
  try {
    gate.releaseAll(); // no parking: let the pool run flat out
    analyzer.tick();
    await until(() => gate.requests.length >= ids.length, 'every thread runs');
    await quiet();
    assert.equal(gate.requests.length, ids.length, 'no thread was analyzed twice');
    for (const id of ids) assert.equal(db.getAnalysisForThread(id)?.urgency, 'P1');
  } finally {
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

// ---------------------------------------------------------------------------
// 2. never two analyses of the same thread
// ---------------------------------------------------------------------------

test('a thread already in flight is never started a second time', async () => {
  const id = eligibleThread('solo');
  const gate = gatedHarness('same-thread-fake');
  await probe.ensureSafetyProof(gate.provider, {});
  harness.setActiveHarness(gate.provider);
  try {
    analyzer.tick();
    await until(() => gate.parked === 1, 'the run reaches the harness');
    assert.deepEqual(analyzerHealth().currentThreadIds, [id]);

    // A reply lands mid-analysis, so the thread is stale again — and the pool has two
    // free slots. It must STILL not be picked up, because it is already running.
    db.markThreadActive(id, ts(0));
    assert.deepEqual(db.listThreadsNeedingAnalysis().map((t) => t.id), [id], 'stale again');
    assert.equal(analyzer.pickNext(), null, 'but not offered while it is in flight');
    analyzer.tick();
    analyzer.tick();
    await settle();
    assert.equal(gate.requests.length, 1, 'still exactly one run of this thread');

    // Nor can a forced re-analysis double it — the force waits its turn instead.
    assert.equal(analyzer.requestReanalysis(id).ok, true);
    await settle();
    assert.equal(gate.requests.length, 1, 'a forced request cannot double a live run');
    assert.deepEqual(analyzerHealth().currentThreadIds, [id]);

    // When the run finishes, the queued force is honoured — it was not dropped.
    gate.releaseAll();
    await until(() => gate.requests.length === 2, 'the deferred force runs');
    assert.equal(gate.requests.length, 2, 'the deferred force ran afterwards');
  } finally {
    gate.releaseAll();
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

// ---------------------------------------------------------------------------
// 3. concurrency 1 is the old scheduler, byte for byte
// ---------------------------------------------------------------------------

/**
 * COPILOT_ANALYZER_CONCURRENCY is read once, at import (like PORT), so each value needs
 * its own process. The probe seeds a backlog of message-less threads, calls tick() ONCE,
 * and reports what the scheduler did.
 */
function burstWith(concurrency: string | undefined, backlog = 6): {
  configured: number;
  backlog: number;
  startedByOneTick: number;
  attemptsAfterOneTick: number;
  idleAtEnd: boolean;
} {
  const env = { ...process.env, COPILOT_DB_PATH: TEST_DB_PATH, BURST_THREADS: String(backlog) };
  if (concurrency === undefined) delete env.COPILOT_ANALYZER_CONCURRENCY;
  else env.COPILOT_ANALYZER_CONCURRENCY = concurrency;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, 'test', 'helpers', 'print-scheduler-burst.ts')],
    { cwd: projectRoot, env, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}');
}

test('COPILOT_ANALYZER_CONCURRENCY=1 reproduces the old strictly-serial scheduler', () => {
  const serial = burstWith('1');
  assert.equal(serial.configured, 1);
  assert.equal(serial.startedByOneTick, 1, 'one tick starts exactly one analysis');
  // The old scheduler took at most one thread per 15s heartbeat and never reached for the
  // next one when a run ended. That timing IS the serial behaviour, so it is pinned here.
  assert.equal(
    serial.attemptsAfterOneTick,
    1,
    'a finished run does not pull the next thread: that waits for the heartbeat',
  );
  assert.equal(serial.idleAtEnd, true);
});

test('above 1, one tick fills the pool and freed slots refill themselves', () => {
  for (const n of [2, 3, 4]) {
    const burst = burstWith(String(n));
    assert.equal(burst.configured, n);
    assert.equal(burst.startedByOneTick, n, `N=${n}: one tick fills the pool exactly`);
    assert.ok(burst.startedByOneTick < burst.backlog, `N=${n}: and the cap held work back`);
    assert.equal(
      burst.attemptsAfterOneTick,
      burst.backlog,
      `N=${n}: the backlog drains without waiting for the next heartbeat`,
    );
    assert.equal(burst.idleAtEnd, true);
  }
});

test('the ceiling is enforced in a real process, not only in the parser', () => {
  const greedy = burstWith('16', 8);
  assert.equal(greedy.configured, MAX_ANALYZER_CONCURRENCY);
  assert.equal(greedy.startedByOneTick, MAX_ANALYZER_CONCURRENCY, 'never 16 at once');
});

// ---------------------------------------------------------------------------
// 4. adaptive backoff on rate_limit / budget
// ---------------------------------------------------------------------------

/** Seed one fresh thread and drive its analysis to completion through the pool. */
async function runOne(tag: string): Promise<void> {
  const id = eligibleThread(tag);
  analyzer.tick();
  await until(() => analyzerHealth().currentThreadIds.includes(id), `#${id} starts`);
  await quiet();
}

function throwingHarness(id: string, err: () => unknown): HarnessProvider {
  return makeFakeHarness({ id, script: [], throws: err }).provider;
}

test('a rate_limit narrows the pool toward 1, and steady success widens it again', async () => {
  assert.equal(analyzer.effectiveConcurrency(), N, 'starts at the configured width');

  const limited = throwingHarness('rate-limited-fake', () => new ClassifiedError('rate_limit', 'slow down'));
  await probe.ensureSafetyProof(limited, {});
  harness.setActiveHarness(limited);
  try {
    // The kind comes from the real classifier (health.ts → provider.classifyError), which
    // is the whole point: no second copy of the rate-limit wording lives in the scheduler.
    await runOne('rl1');
    assert.equal(analyzerHealth().lastError?.kind, 'rate_limit');
    assert.equal(analyzer.effectiveConcurrency(), 2, 'halved, rounding up — not straight to 1');

    await runOne('rl2');
    assert.equal(analyzer.effectiveConcurrency(), 1, 'a second signal walks it down to serial');

    await runOne('rl3');
    assert.equal(analyzer.effectiveConcurrency(), 1, 'and it never goes below 1');
  } finally {
    harness.setActiveHarness(idleProvider);
  }

  // Recovery is deliberately slower than the drop: three clean runs per step back up.
  const healthy = makeFakeHarness({ id: 'healthy-fake', script: verdictEvents('sess-ok') }).provider;
  await probe.ensureSafetyProof(healthy, {});
  harness.setActiveHarness(healthy);
  try {
    await runOne('ok1');
    assert.equal(analyzer.effectiveConcurrency(), 1, 'one success is not a recovery');
    await runOne('ok2');
    assert.equal(analyzer.effectiveConcurrency(), 1);
    await runOne('ok3');
    assert.equal(analyzer.effectiveConcurrency(), 2, 'three clean runs buy one slot back');

    await runOne('ok4');
    await runOne('ok5');
    await runOne('ok6');
    assert.equal(analyzer.effectiveConcurrency(), N, 'and eventually the configured width');

    await runOne('ok7');
    await runOne('ok8');
    await runOne('ok9');
    assert.equal(analyzer.effectiveConcurrency(), N, 'never above what the user configured');
  } finally {
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

test('a budget failure backs off the same way', async () => {
  const broke = throwingHarness('broke-fake', () => new ClassifiedError('budget', 'usage limit reached'));
  await probe.ensureSafetyProof(broke, {});
  harness.setActiveHarness(broke);
  try {
    await runOne('b1');
    assert.equal(analyzerHealth().lastError?.kind, 'budget');
    assert.equal(analyzer.effectiveConcurrency(), 2);
    await runOne('b2');
    assert.equal(analyzer.effectiveConcurrency(), 1);
  } finally {
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

test('an ordinary failure does NOT narrow the pool — only throttling signals do', async () => {
  const broken = throwingHarness('broken-fake', () => new Error('thread has no messages'));
  await probe.ensureSafetyProof(broken, {});
  harness.setActiveHarness(broken);
  try {
    await runOne('u1');
    await runOne('u2');
    await runOne('u3');
    assert.equal(analyzerHealth().lastError?.kind, 'unknown');
    assert.equal(
      analyzer.effectiveConcurrency(),
      N,
      'a thread that simply failed is not the harness asking us to slow down',
    );
  } finally {
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

test('the narrowed width is reported to the UI, alongside what was configured', async () => {
  const limited = throwingHarness('reported-fake', () => new ClassifiedError('rate_limit', 'slow down'));
  await probe.ensureSafetyProof(limited, {});
  harness.setActiveHarness(limited);
  try {
    await runOne('rep1');
    const health = analyzerHealth();
    assert.deepEqual(health.concurrency, { limit: 2, configured: N });
  } finally {
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

// ---------------------------------------------------------------------------
// 5. forced re-analysis still jumps the queue
// ---------------------------------------------------------------------------

test('a forced re-analysis jumps the queue even when the pool is already busy', async () => {
  // Fill the pool with older work, leave one ordinary thread queued behind it, and then
  // force a thread that is not even eligible — it is still inside the 45s debounce.
  // pickNext takes the most recently active first, so `waiting` is seeded oldest: it is
  // eligible, but last in line.
  for (let i = 0; i < N; i++) eligibleThread(`recent${i}`, 600 + i);
  const waiting = eligibleThread('waiting', 9_000);
  const noisy = seedThread({ channel_id: 'C_noisy', thread_ts: 'noisy', last_activity: ts(1) });
  seedMessage({ thread_id: noisy, text: 'just said something' });

  const gate = gatedHarness('forced-fake');
  await probe.ensureSafetyProof(gate.provider, {});
  harness.setActiveHarness(gate.provider);
  try {
    analyzer.tick();
    await until(() => gate.parked === N, 'the pool fills with the older work');
    const running = analyzerHealth().currentThreadIds;
    assert.equal(running.length, N);
    assert.equal(running.includes(waiting), false, 'one ordinary thread is queued behind it');
    assert.equal(running.includes(noisy), false, 'and the noisy thread is inside its debounce');

    // Ask for the noisy thread, then free exactly one slot.
    assert.equal(analyzer.requestReanalysis(noisy).ok, true);
    gate.releaseOne();
    await until(() => gate.requests.length === N + 1, 'the freed slot is taken');

    const nowRunning = analyzerHealth().currentThreadIds;
    assert.equal(
      nowRunning.includes(noisy),
      true,
      'the forced thread took the free slot — skipping both the debounce and the queue',
    );
    assert.equal(nowRunning.includes(waiting), false, 'ahead of an older, already-eligible thread');
    assert.equal(db.getAnalysisForThread(waiting), undefined, 'which has not run at all yet');
  } finally {
    gate.releaseAll();
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

// ---------------------------------------------------------------------------
// health reporting with several runs in flight
// ---------------------------------------------------------------------------

test('currentThreadId is the longest-running analysis; currentThreadIds has them all', async () => {
  for (let i = 0; i < N; i++) eligibleThread(`report${i}`, 900 - i * 10);
  const gate = gatedHarness('report-fake');
  await probe.ensureSafetyProof(gate.provider, {});
  harness.setActiveHarness(gate.provider);
  try {
    assert.equal(analyzerHealth().currentThreadId, null, 'null while idle, as always');
    assert.deepEqual(analyzerHealth().currentThreadIds, []);

    analyzer.tick();
    await until(() => gate.parked === N, 'the pool fills');
    const health = analyzerHealth();
    assert.equal(health.currentThreadIds.length, N);
    assert.equal(
      health.currentThreadId,
      health.currentThreadIds[0],
      'the scalar is the first (longest-running) entry, so it does not hop about',
    );
    assert.equal(health.state, 'analyzing');

    // One finishing does not blank the field its siblings are still using.
    gate.releaseOne();
    await until(() => analyzerHealth().currentThreadIds.length === N - 1, 'one run finishes');
    const during = analyzerHealth();
    assert.equal(during.currentThreadIds.length, N - 1);
    assert.notEqual(during.currentThreadId, null, 'still analyzing, so still reported');
    assert.equal(during.state, 'analyzing', 'a success while siblings run is not "idle"');

    gate.releaseAll();
    await until(() => analyzerHealth().currentThreadIds.length === 0, 'the pool empties');
    const after = analyzerHealth();
    assert.equal(after.currentThreadId, null);
    assert.deepEqual(after.currentThreadIds, []);
    assert.equal(after.state, 'idle');
  } finally {
    gate.releaseAll();
    harness.setActiveHarness(idleProvider);
    await settle();
  }
});

test('the snapshot is a copy: mutating it cannot corrupt the registry', () => {
  const snap = analyzerHealth();
  snap.currentThreadIds.push(999);
  snap.concurrency.limit = 99;
  assert.deepEqual(analyzerHealth().currentThreadIds, []);
  assert.notEqual(analyzerHealth().concurrency.limit, 99);
});
