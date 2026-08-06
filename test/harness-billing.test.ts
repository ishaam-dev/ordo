/**
 * THE SPEND GUARD — docs/harness-providers.md §6.
 *
 * Claude Code bills a subscription the user already pays for; Pi and Codex can bill per
 * token against a key the user owns. The analyzer is a background loop over every thread,
 * so that is the money risk — not chat, which is one deliberate click. A harness that
 * bills per token therefore does not get to start the analyzer until the user says so.
 *
 * startAnalyzer() flips state that cannot be flipped back and COPILOT_HARNESS_SPEND_OK is
 * read at import, so each case runs in its own process.
 */
import './helpers/env.js';
import { TEST_DB_PATH } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function analyzerStateWith(vars: Record<string, string | undefined>): {
  state: string;
  note: string | null;
} {
  const env = { ...process.env, COPILOT_DB_PATH: TEST_DB_PATH };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, 'test', 'helpers', 'print-analyzer-state.ts')],
    { cwd: projectRoot, env, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as { state: string; note: string | null };
}

test('a per-token harness does NOT start the background analyzer on its own', () => {
  const health = analyzerStateWith({ COPILOT_HARNESS_SPEND_OK: undefined, FAKE_BILLING: 'api-key' });
  assert.equal(health.state, 'disabled');
  assert.match(String(health.note), /charges your own AI account for every message it reviews/);
  assert.match(String(health.note), /COPILOT_HARNESS_SPEND_OK=1/);
  // Plain English, and it names the harness rather than "the provider".
  assert.match(String(health.note), /^Pi-ish /);
  assert.doesNotMatch(String(health.note), /\bAPI\b|\bSDK\b|\btoken\b/);
});

test('with the acknowledgement, the same harness runs the analyzer', () => {
  const health = analyzerStateWith({ COPILOT_HARNESS_SPEND_OK: '1', FAKE_BILLING: 'api-key' });
  assert.equal(health.state, 'idle');
  assert.equal(health.note, null);
});

test('a subscription harness needs no acknowledgement — today\'s behaviour is unchanged', () => {
  const health = analyzerStateWith({
    COPILOT_HARNESS_SPEND_OK: undefined,
    FAKE_BILLING: 'subscription',
  });
  assert.equal(health.state, 'idle');
  assert.equal(health.note, null);
});

test('ANALYZER_DISABLED still wins, and still says nothing about money', () => {
  const health = analyzerStateWith({
    ANALYZER_DISABLED: '1',
    COPILOT_HARNESS_SPEND_OK: undefined,
    FAKE_BILLING: 'api-key',
  });
  assert.equal(health.state, 'disabled');
  assert.equal(health.note, null);
});

test('chat is never gated by the spend guard: one click is not a background loop', async () => {
  // The guard lives in startAnalyzer() only — nothing in the chat path consults it.
  const { readFileSync } = await import('node:fs');
  const chatSource = readFileSync(path.join(projectRoot, 'src', 'chat.ts'), 'utf8');
  assert.equal(/spendAcknowledged|COPILOT_HARNESS_SPEND_OK/.test(chatSource), false);
  const analyzerSource = readFileSync(path.join(projectRoot, 'src', 'analyzer.ts'), 'utf8');
  assert.equal(/spendAcknowledged/.test(analyzerSource), true);
});
