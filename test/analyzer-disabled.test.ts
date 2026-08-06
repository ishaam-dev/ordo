/**
 * CHARACTERIZATION — ANALYZER_DISABLED=1.
 *
 * In its own file because `startAnalyzer()` flips module-level state that can never be
 * flipped back, and because it must run without a heartbeat timer being installed.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, seedThread } from './helpers/fixtures.js';

process.env.ANALYZER_DISABLED = '1';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);
const { startAnalyzer, requestReanalysis, pickNext } = await import('../src/analyzer.js');
const { analyzerHealth } = await import('../src/health.js');

resetDb();

test('ANALYZER_DISABLED=1: startAnalyzer installs no worker and reports "disabled"', () => {
  const id = seedThread({ last_activity: (Date.now() / 1000 - 600).toFixed(6) });

  assert.equal(analyzerHealth().state, 'idle');
  startAnalyzer();
  assert.equal(analyzerHealth().state, 'disabled');
  // The backlog is still counted, so the UI can say "N waiting, prioritizing is off".
  assert.equal(analyzerHealth().queued, 1);
  assert.equal(analyzerHealth().currentThreadId, null);

  // The thread is still *eligible* — nothing is scheduled to pick it up.
  assert.equal(pickNext()?.id, id);
});

test('ANALYZER_DISABLED=1: reanalyze is refused with reason "disabled"', () => {
  const id = seedThread({ channel_id: 'C9', thread_ts: '9', last_activity: '1000.000100' });
  assert.deepEqual(requestReanalysis(id), { ok: false, reason: 'disabled' });
  // Refused before the id is even validated…
  assert.deepEqual(requestReanalysis(-1), { ok: false, reason: 'disabled' });
  assert.deepEqual(requestReanalysis(999_999), { ok: false, reason: 'disabled' });
});

test('ANALYZER_DISABLED=1: the disabled state survives success/failure reports', async () => {
  const health = await import('../src/health.js');
  health.analyzerRunStarted(1);
  assert.equal(analyzerHealth().state, 'disabled', 'a start report cannot un-disable it');
  health.analyzerRunSucceeded();
  assert.equal(analyzerHealth().state, 'disabled');
  health.analyzerRunFailed({
    kind: 'unknown',
    message: 'm',
    hint: 'h',
    command: null,
    at: new Date().toISOString(),
    detail: 'd',
  });
  assert.equal(analyzerHealth().state, 'disabled');
});
