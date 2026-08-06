/**
 * CHARACTERIZATION — src/config.ts: which workspaces count as configured, and how PORT
 * is parsed.
 *
 * No real `.env` is ever read: helpers/env.ts points dotenv at a path that does not exist
 * before this module imports anything from src/. Every token literal here is obviously
 * fake.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { tokenIfValid, loadWorkspaces, workspaces, PORT } = await import('../src/config.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// token shape validation (prefix + length only — values are never inspected)
// ---------------------------------------------------------------------------

test('tokenIfValid: accepts a value with the right prefix, trimmed', () => {
  assert.equal(tokenIfValid('xoxp-fake-user', 'xoxp-'), 'xoxp-fake-user');
  assert.equal(tokenIfValid('  xoxp-fake-user  ', 'xoxp-'), 'xoxp-fake-user');
  assert.equal(tokenIfValid('xapp-fake-app', 'xapp-'), 'xapp-fake-app');
});

test('tokenIfValid: rejects empty, missing and wrong-prefix values', () => {
  assert.equal(tokenIfValid(undefined, 'xoxp-'), null);
  assert.equal(tokenIfValid('', 'xoxp-'), null);
  assert.equal(tokenIfValid('   ', 'xoxp-'), null);
  assert.equal(tokenIfValid('xoxb-fake-bot', 'xoxp-'), null, 'a bot token is not a user token');
  assert.equal(tokenIfValid('xapp-fake', 'xoxp-'), null);
  assert.equal(tokenIfValid('XOXP-FAKE', 'xoxp-'), null, 'the prefix check is case-sensitive');
});

test('tokenIfValid: rejects anything containing "..." as a placeholder', () => {
  assert.equal(tokenIfValid('xoxp-...', 'xoxp-'), null);
  assert.equal(tokenIfValid('xoxp-abc...def', 'xoxp-'), null, 'anywhere in the value, not just at the end');
});

// ---------------------------------------------------------------------------
// a workspace is active only if BOTH tokens are present and well-shaped
// ---------------------------------------------------------------------------

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('loadWorkspaces: a workspace needs both an xoxp- user token and an xapp- app token', () => {
  const loaded = withEnv(
    {
      SLACK_A_USER_TOKEN: 'xoxp-fake-a',
      SLACK_A_APP_TOKEN: 'xapp-fake-a',
      SLACK_B_USER_TOKEN: undefined,
      SLACK_B_APP_TOKEN: undefined,
    },
    loadWorkspaces,
  );
  assert.deepEqual(loaded, [{ key: 'A', userToken: 'xoxp-fake-a', appToken: 'xapp-fake-a' }]);
});

test('loadWorkspaces: both slots load, in A-then-B order', () => {
  const loaded = withEnv(
    {
      SLACK_A_USER_TOKEN: 'xoxp-fake-a',
      SLACK_A_APP_TOKEN: 'xapp-fake-a',
      SLACK_B_USER_TOKEN: 'xoxp-fake-b',
      SLACK_B_APP_TOKEN: 'xapp-fake-b',
    },
    loadWorkspaces,
  );
  assert.deepEqual(loaded.map((w) => w.key), ['A', 'B']);
});

test('loadWorkspaces: a half-configured workspace is skipped entirely', () => {
  for (const half of [
    { SLACK_A_USER_TOKEN: 'xoxp-fake-a', SLACK_A_APP_TOKEN: undefined },
    { SLACK_A_USER_TOKEN: undefined, SLACK_A_APP_TOKEN: 'xapp-fake-a' },
    { SLACK_A_USER_TOKEN: 'xoxp-fake-a', SLACK_A_APP_TOKEN: 'xoxp-wrong-prefix' },
    { SLACK_A_USER_TOKEN: 'xoxp-...', SLACK_A_APP_TOKEN: 'xapp-fake-a' },
    { SLACK_A_USER_TOKEN: '', SLACK_A_APP_TOKEN: 'xapp-fake-a' },
  ]) {
    const loaded = withEnv(
      { ...half, SLACK_B_USER_TOKEN: undefined, SLACK_B_APP_TOKEN: undefined },
      loadWorkspaces,
    );
    assert.deepEqual(loaded, [], JSON.stringify(Object.keys(half)));
  }
});

test('loadWorkspaces: no tokens at all is a valid, silent configuration', () => {
  const loaded = withEnv(
    {
      SLACK_A_USER_TOKEN: undefined,
      SLACK_A_APP_TOKEN: undefined,
      SLACK_B_USER_TOKEN: undefined,
      SLACK_B_APP_TOKEN: undefined,
    },
    loadWorkspaces,
  );
  assert.deepEqual(loaded, []);
});

test('the module-level workspaces list is empty in a test process', () => {
  // Proof that no real `.env` was read — nothing else in the suite may assume tokens.
  assert.deepEqual(workspaces, []);
});

// ---------------------------------------------------------------------------
// PORT (computed once, at import — hence a child process per case)
// ---------------------------------------------------------------------------

function portWith(value: string | undefined): number {
  const env = { ...process.env };
  delete env.PORT;
  if (value !== undefined) env.PORT = value;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, 'test', 'helpers', 'print-port.ts')],
    { cwd: projectRoot, env, encoding: 'utf8' },
  );
  return Number(out.trim());
}

test('PORT defaults to 5252 and accepts a valid port number', () => {
  assert.equal(PORT, 5252, 'unset in this process');
  assert.equal(portWith(undefined), 5252);
  assert.equal(portWith('3000'), 3000);
  assert.equal(portWith('  8080  '), 8080);
  assert.equal(portWith('65535'), 65535);
});

test('PORT falls back to 5252 for anything out of range or not an integer', () => {
  for (const bad of ['', '0', '-1', '65536', '99999', 'abc', '5252.5', 'NaN', 'Infinity']) {
    assert.equal(portWith(bad), 5252, `PORT=${JSON.stringify(bad)}`);
  }
});

test('PORT: QUIRK — Number() coercion accepts hex and exponent notation', () => {
  // The parser is `Number(raw)`, so these are read as 16 and 1000, not rejected.
  assert.equal(portWith('0x10'), 16);
  assert.equal(portWith('1e3'), 1000);
});
