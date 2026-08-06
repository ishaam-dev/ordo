/**
 * CHARACTERIZATION — src/health.ts failure classification and the health registry.
 *
 * REFACTOR NOTE: everything in the "text matching" section below is *Claude-Code-specific*
 * — the strings come out of @anthropic-ai/claude-agent-sdk or the CLI it spawns. A
 * pluggable harness needs one of these tables per harness; the copy (message/hint/command)
 * is harness-independent and should stay shared.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  ClassifiedError,
  classifyAnalyzerError,
  analyzerHealth,
  analyzerRunStarted,
  analyzerRunSucceeded,
  analyzerRunFailed,
  setAnalyzerQueued,
  setAnalyzerDisabled,
  registerIngestHealth,
  listWorkspaceHealth,
} = await import('../src/health.js');

const kindOf = (text: string): string => classifyAnalyzerError(new Error(text)).kind;

// ---------------------------------------------------------------------------
// text matching — one representative string per bucket, from the SDK/CLI
// ---------------------------------------------------------------------------

test('auth: the real string this app sees when Claude is logged out', () => {
  // Verbatim from the SDK on a machine with no Claude login.
  assert.equal(
    kindOf(
      'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed',
    ),
    'auth',
  );
});

for (const [text, expected] of [
  // auth
  ['Failed to authenticate', 'auth'],
  ['OAuth token invalid', 'auth'],
  ['Not logged in', 'auth'],
  ['You have been logged out', 'auth'],
  ['Please log in first', 'auth'],
  ['login required', 'auth'],
  ['not signed in', 'auth'],
  ['unauthorized', 'auth'],
  ['request failed with status 401', 'auth'],
  ['invalid credential', 'auth'],
  // budget
  ['Your credit balance is too low', 'budget'],
  ['usage limit reached', 'budget'],
  ['quota exceeded', 'budget'],
  ['insufficient funds', 'budget'],
  ['billing error', 'budget'],
  ['please upgrade your plan', 'budget'],
  ['budget exceeded', 'budget'],
  ['out of credits', 'budget'],
  // rate limit
  ['rate limit exceeded', 'rate_limit'],
  ['rate-limited', 'rate_limit'],
  ['Too Many Requests', 'rate_limit'],
  ['HTTP 429', 'rate_limit'],
  ['Overloaded', 'rate_limit'],
  ['error 529', 'rate_limit'],
  ['please try again later', 'rate_limit'],
  // timeout
  ['timed out after 180s', 'timeout'],
  ['timeout while waiting', 'timeout'],
  ['ETIMEDOUT', 'timeout'],
  ['deadline exceeded', 'timeout'],
  ['The operation was aborted', 'timeout'],
  // bad output
  ['no JSON object found in result', 'bad_output'],
  ['result JSON failed to parse', 'bad_output'],
  ['unbalanced JSON object in result', 'bad_output'],
  ['result urgency is not one of P0..P3', 'bad_output'],
  ['error_max_turns', 'bad_output'],
  ['max turns reached', 'bad_output'],
  // unknown
  ['stream ended without a result', 'unknown'],
  ['thread has no messages', 'unknown'],
  ['ECONNRESET', 'unknown'],
  ['something went wrong', 'unknown'],
  ['', 'unknown'],
] as const) {
  test(`classify ${JSON.stringify(text)} → ${expected}`, () => {
    assert.equal(kindOf(text), expected);
  });
}

test('classification is case-insensitive', () => {
  assert.equal(kindOf('FAILED TO AUTHENTICATE'), 'auth');
  assert.equal(kindOf('Rate Limit'), 'rate_limit');
  assert.equal(kindOf('TIMED OUT'), 'timeout');
});

test('order of precedence: auth beats budget beats rate_limit beats timeout beats bad_output', () => {
  assert.equal(kindOf('authentication failed: usage limit, rate limit, timed out, bad json'), 'auth');
  assert.equal(kindOf('usage limit reached, rate limit, timed out, bad json'), 'budget');
  assert.equal(kindOf('rate limit, timed out, bad json'), 'rate_limit');
  assert.equal(kindOf('timed out, bad json'), 'timeout');
  assert.equal(kindOf('bad json'), 'bad_output');
});

test('QUIRK — any message containing the word "author" is classified as a sign-in failure', () => {
  // AUTH_RE is /\bauth\w*|.../ so "author", "authored", "authority" all match, and the user
  // is told to run `claude auth login` for an unrelated problem.
  assert.equal(kindOf('author not found for message'), 'auth');
  assert.equal(kindOf('missing authority header'), 'auth');
  assert.equal(classifyAnalyzerError(new Error('author not found')).command, 'claude auth login');
});

test('QUIRK — "aborted" is bucketed as a timeout, so a user-cancelled run reads as slow', () => {
  assert.equal(kindOf('The user aborted a request'), 'timeout');
});

// ---------------------------------------------------------------------------
// structural classification wins over text matching
// ---------------------------------------------------------------------------

test('ClassifiedError: the declared kind wins, whatever the text says', () => {
  assert.equal(classifyAnalyzerError(new ClassifiedError('bad_output', 'no JSON object')).kind, 'bad_output');
  // Text that would otherwise classify as auth, declared as a timeout:
  assert.equal(
    classifyAnalyzerError(new ClassifiedError('timeout', 'Failed to authenticate')).kind,
    'timeout',
  );
  assert.equal(classifyAnalyzerError(new ClassifiedError('unknown', '401')).kind, 'unknown');
});

test('ClassifiedError is a real Error with name "ClassifiedError"', () => {
  const err = new ClassifiedError('budget', 'nope');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ClassifiedError');
  assert.equal(err.kind, 'budget');
  assert.equal(err.message, 'nope');
});

test('a non-Error throw is stringified before matching', () => {
  assert.equal(classifyAnalyzerError('plain string 401').kind, 'auth');
  assert.equal(classifyAnalyzerError({ toString: () => 'rate limit' }).kind, 'rate_limit');
  assert.equal(classifyAnalyzerError(null).kind, 'unknown');
  assert.equal(classifyAnalyzerError(undefined).kind, 'unknown');
});

test('detail is the raw text, truncated to 300 characters', () => {
  const failure = classifyAnalyzerError(new Error('x'.repeat(500)));
  assert.equal(failure.detail.length, 300);
  assert.equal(failure.detail, 'x'.repeat(300));
  assert.match(failure.at, /^\d{4}-\d{2}-\d{2}T/);
});

// ---------------------------------------------------------------------------
// user-facing copy — shown verbatim to a non-technical reader
// ---------------------------------------------------------------------------

test('every bucket carries exact plain-English copy', () => {
  const copy = (text: string): Record<string, unknown> => {
    const f = classifyAnalyzerError(new Error(text));
    return { kind: f.kind, message: f.message, hint: f.hint, command: f.command };
  };
  assert.deepEqual(copy('Failed to authenticate'), {
    kind: 'auth',
    message: "Claude isn't signed in on this Mac",
    hint: 'Open Terminal and run: claude auth login',
    command: 'claude auth login',
  });
  assert.deepEqual(copy('timed out'), {
    kind: 'timeout',
    message: 'Claude took too long to review a message',
    hint: 'It will try again on its own in a few minutes. If every message stalls, quit and reopen the app.',
    command: null,
  });
  assert.deepEqual(copy('rate limit'), {
    kind: 'rate_limit',
    message: 'Claude is temporarily busy and asked us to slow down',
    hint: 'This usually clears by itself within a few minutes. Nothing for you to do.',
    command: null,
  });
  assert.deepEqual(copy('usage limit'), {
    kind: 'budget',
    message: "Claude's usage limit for this plan has been reached",
    hint: 'Prioritizing starts again when the limit resets, or on a higher Claude plan.',
    command: null,
  });
  assert.deepEqual(copy('no JSON object'), {
    kind: 'bad_output',
    message: "Claude's answer came back in a form this app could not read",
    hint: 'Usually a one-off. It retries in a few minutes, or press Re-analyze on the message.',
    command: null,
  });
  assert.deepEqual(copy('mystery'), {
    kind: 'unknown',
    message: "Claude couldn't review this message",
    hint: 'It will try again in a few minutes. If it keeps happening, quit and reopen the app.',
    command: null,
  });
});

test('copy never leaks jargon a non-technical reader would not know', () => {
  const banned = /\bOAuth\b|\bSDK\b|\btoken\b|\bdaemon\b|\bstderr\b|\bsubprocess\b/i;
  for (const text of ['Failed to authenticate', 'timed out', 'rate limit', 'usage limit', 'no JSON', 'x']) {
    const f = classifyAnalyzerError(new Error(text));
    assert.doesNotMatch(f.message, banned, `message for ${f.kind}`);
    assert.doesNotMatch(f.hint, banned, `hint for ${f.kind}`);
  }
});

// ---------------------------------------------------------------------------
// the analyzer registry
// ---------------------------------------------------------------------------

test('registry: started → succeeded → failed transitions', () => {
  assert.equal(analyzerHealth().state, 'idle');

  analyzerRunStarted(7);
  assert.equal(analyzerHealth().state, 'analyzing');
  assert.equal(analyzerHealth().currentThreadId, 7);

  analyzerRunSucceeded();
  const ok = analyzerHealth();
  assert.equal(ok.state, 'idle');
  assert.equal(ok.currentThreadId, null);
  assert.equal(ok.consecutiveFailures, 0);
  assert.equal(ok.lastError, null);
  assert.match(String(ok.lastOk), /^\d{4}-\d{2}-\d{2}T/);

  const failure = classifyAnalyzerError(new Error('boom'));
  analyzerRunStarted(8);
  analyzerRunFailed(failure);
  const bad = analyzerHealth();
  assert.equal(bad.state, 'error');
  assert.equal(bad.currentThreadId, null);
  assert.equal(bad.consecutiveFailures, 1);
  assert.deepEqual(bad.lastError, failure);
  assert.equal(bad.lastOk, ok.lastOk, 'lastOk survives a later failure');

  analyzerRunFailed(failure);
  assert.equal(analyzerHealth().consecutiveFailures, 2);

  analyzerRunSucceeded();
  assert.equal(analyzerHealth().consecutiveFailures, 0, 'a success clears the streak');
  assert.equal(analyzerHealth().lastError, null, 'and clears the last error');
});

test('registry: the snapshot is a copy, not the live object', () => {
  analyzerRunFailed(classifyAnalyzerError(new Error('boom')));
  const snap = analyzerHealth();
  snap.queued = 999;
  if (snap.lastError) snap.lastError.message = 'tampered';
  assert.notEqual(analyzerHealth().queued, 999);
  assert.notEqual(analyzerHealth().lastError?.message, 'tampered');
  analyzerRunSucceeded();
});

test('registry: queued is clamped at zero', () => {
  setAnalyzerQueued(5);
  assert.equal(analyzerHealth().queued, 5);
  setAnalyzerQueued(-3);
  assert.equal(analyzerHealth().queued, 0);
});

test('registry: disabled is terminal for this process', () => {
  setAnalyzerDisabled();
  assert.equal(analyzerHealth().state, 'disabled');
  analyzerRunStarted(1);
  assert.equal(analyzerHealth().state, 'disabled');
  analyzerRunSucceeded();
  assert.equal(analyzerHealth().state, 'disabled');
  analyzerRunFailed(classifyAnalyzerError(new Error('x')));
  assert.equal(analyzerHealth().state, 'disabled');
});

// ---------------------------------------------------------------------------
// ingest / workspace health
// ---------------------------------------------------------------------------

test('workspaces: nothing is claimed about a workspace ingest never reported', () => {
  // No tokens are configured in a test process, so the configured list is empty and the
  // only rows are the ones ingest registers.
  assert.deepEqual(listWorkspaceHealth(), []);
});

test('workspaces: a report is remembered, and partial updates merge into it', () => {
  registerIngestHealth('A', { state: 'connecting', message: 'Connecting to Slack…' });
  let a = listWorkspaceHealth().find((w) => w.key === 'A');
  assert.deepEqual(
    { registered: a?.registered, state: a?.state, connected: a?.connected, teamName: a?.teamName, message: a?.message },
    { registered: true, state: 'connecting', connected: false, teamName: null, message: 'Connecting to Slack…' },
  );
  assert.match(String(a?.since), /^\d{4}-\d{2}-\d{2}T/);

  // A report with no `state` keeps the previous state AND the previous message.
  registerIngestHealth('A', { teamName: 'Acme Inc' });
  a = listWorkspaceHealth().find((w) => w.key === 'A');
  assert.equal(a?.state, 'connecting');
  assert.equal(a?.teamName, 'Acme Inc');
  assert.equal(a?.message, 'Connecting to Slack…');

  // A report WITH a state and no message clears the message.
  registerIngestHealth('A', { state: 'connected' });
  a = listWorkspaceHealth().find((w) => w.key === 'A');
  assert.equal(a?.state, 'connected');
  assert.equal(a?.connected, true);
  assert.equal(a?.message, null);
  assert.equal(a?.teamName, 'Acme Inc', 'teamName is sticky');

  registerIngestHealth('A', {
    state: 'reconnecting',
    message: 'Lost the connection to Slack — trying again. Nothing sent meanwhile is lost.',
  });
  a = listWorkspaceHealth().find((w) => w.key === 'A');
  assert.equal(a?.connected, false);
});

test('workspaces: the key is stringified and unknown keys still show up', () => {
  registerIngestHealth('Z', { state: 'error', message: 'Could not connect to Slack.' });
  const keys = listWorkspaceHealth().map((w) => w.key);
  assert.ok(keys.includes('Z'));
  assert.ok(keys.every((k) => typeof k === 'string'));
});
