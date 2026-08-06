/**
 * The harness contract: selection, the registration checks, the environment policy, the
 * session plan, the dialect table and the two presets.
 *
 * `pi`, `codex` and `gemini` are NOT installed on this machine, and that is the point:
 * the presets are data, verified here by unit test and by the availability probe reporting
 * them unavailable in plain English — never by running them.
 */
import './helpers/env.js';
import { TEST_DB_PATH } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeHarness } from './helpers/fake-harness.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  REGISTRY,
  defineHarness,
  harnessIds,
  harnessStatus,
  harnessReadiness,
  limitationsFor,
  planSession,
  selectHarness,
  activeHarness,
  sanitizeEnv,
} = await import('../src/harness/index.js');
const { harnessConfigFromEnv, DEFAULT_HARNESS_ID } = await import('../src/harness/env.js');
const { EVENT_DIALECTS, readPath, matches } = await import('../src/harness/dialects.js');
const { mapEvent } = await import('../src/harness/cli.js');
const { PI } = await import('../src/harness/presets/pi.js');
const { CODEX } = await import('../src/harness/presets/codex.js');
const { copyFor } = await import('../src/harness/copy.js');
const config = await import('../src/config.js');

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

test('COPILOT_HARNESS unset means claude-code — an existing install is unchanged', () => {
  assert.equal(DEFAULT_HARNESS_ID, 'claude-code');
  assert.equal(harnessConfigFromEnv({}).id, 'claude-code');
  assert.equal(config.HARNESS_ID, 'claude-code');
  assert.equal(selectHarness().identity.id, 'claude-code');
  assert.equal(activeHarness().identity.id, 'claude-code');
});

test('the registry holds the three harnesses this app ships with', () => {
  assert.deepEqual(harnessIds(), ['claude-code', 'codex', 'pi']);
});

test('an unknown id is fatal, and says which ids do exist', () => {
  assert.throws(() => selectHarness('clod'), (err: Error) => {
    assert.match(err.message, /COPILOT_HARNESS="clod" is not a harness this app knows/);
    assert.match(err.message, /claude-code, codex, pi/);
    assert.match(err.message, /default: claude-code/);
    return true;
  });
  assert.throws(() => selectHarness(''), /not a harness this app knows/);
});

test('boot: an unknown COPILOT_HARNESS exits before anything listens', () => {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, 'src', 'index.ts')],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        COPILOT_HARNESS: 'definitely-not-a-harness',
        COPILOT_DB_PATH: TEST_DB_PATH,
        PORT: '5253',
      },
    },
  );
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 1, 'a typo in the harness name is fatal, not a silent fallback');
  assert.match(output, /is not a harness this app knows/);
  assert.match(output, /claude-code, codex, pi/);
  assert.doesNotMatch(output, /\[server\] listening/, 'it never got as far as a listener');
});

test('friendly spellings resolve; capitalisation is normalised by the config parser', () => {
  assert.equal(selectHarness('claude').identity.id, 'claude-code');
  assert.equal(harnessConfigFromEnv({ COPILOT_HARNESS: '  PI  ' }).id, 'pi');
  assert.equal(selectHarness(harnessConfigFromEnv({ COPILOT_HARNESS: 'Codex' }).id).identity.id, 'codex');
});

test('the other harness switches are parsed next to PORT', () => {
  const parsed = harnessConfigFromEnv({
    COPILOT_HARNESS: 'pi',
    COPILOT_HARNESS_COMMAND: '/opt/bin/pi',
    COPILOT_HARNESS_MODEL: 'sonnet',
    COPILOT_HARNESS_SPEND_OK: '1',
  });
  assert.deepEqual(parsed, { id: 'pi', command: '/opt/bin/pi', model: 'sonnet', spendOk: true });
  assert.deepEqual(harnessConfigFromEnv({ COPILOT_HARNESS_SPEND_OK: 'yes' }).spendOk, false);
  assert.deepEqual(harnessConfigFromEnv({ COPILOT_HARNESS_COMMAND: '  ' }).command, null);
});

// ---------------------------------------------------------------------------
// defineHarness — the unsafe provider is not merely discouraged
// ---------------------------------------------------------------------------

test('defineHarness refuses a provider that cannot back its claims', () => {
  const base = REGISTRY['claude-code'];
  const clone = (over: Record<string, unknown>): never =>
    defineHarness({ ...base, ...over } as never) as never;

  assert.throws(
    () => clone({ capabilities: { ...base.capabilities, tools: { mode: 'read-only', mechanism: 'x', enforcement: 'core-gate', proof: { describe: 'd', run: async () => ({}) } } } }),
    /read-only \+ core-gate requires wireGate/,
  );
  assert.throws(
    () => clone({ capabilities: { ...base.capabilities, tools: { mode: 'read-only', mechanism: 'x', enforcement: 'os-sandbox', proof: { describe: 'd', run: async () => ({}) } } } }),
    /os-sandbox requires residualRisk/,
  );
  assert.throws(
    () => clone({ capabilities: { ...base.capabilities, tools: { mode: 'no-tools', mechanism: 'x' } } }),
    /proof\.run is required/,
  );
  assert.throws(
    () => clone({ capabilities: { ...base.capabilities, tools: { mode: 'anything-goes', mechanism: 'x', proof: { describe: 'd', run: async () => ({}) } } } }),
    /tools\.mode must be/,
  );
  assert.throws(
    () => clone({ capabilities: { ...base.capabilities, tools: { mode: 'no-tools', mechanism: '', proof: { describe: 'd', run: async () => ({}) } } } }),
    /mechanism must say how tools are prevented/,
  );
  assert.throws(() => clone({ identity: { ...base.identity, id: 'Not Valid' } }), /lowercase-hyphenated/);
  assert.throws(() => clone({ identity: { ...base.identity, shortLabel: '' } }), /identity.shortLabel is required/);
  assert.throws(() => clone({ envPolicy: undefined }), /envPolicy is required/);
  assert.throws(() => clone({ run: undefined }), /run\(\) is required/);
  assert.throws(() => clone({ classifyError: undefined }), /classifyError\(\) is required/);
});

test('every registered harness declares an honest tool posture', () => {
  for (const [id, provider] of Object.entries(REGISTRY)) {
    const tools = provider.capabilities.tools;
    assert.ok(['no-tools', 'read-only'].includes(tools.mode), id);
    assert.ok(tools.mechanism.length > 0, id);
    if (tools.mode === 'read-only') {
      assert.ok(
        tools.enforcement === 'core-gate' ? typeof tools.wireGate === 'function' : (tools.residualRisk ?? '') !== '',
        id,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

test('sanitizeEnv: claude-code inherits everything except SLACK_*, CLAUDE* and ANTHROPIC_BASE_URL', () => {
  const base = {
    PATH: '/usr/bin',
    SLACK_A_USER_TOKEN: 'xoxp-nope',
    SLACKISH: 'kept',
    CLAUDECODE: '1',
    CLAUDEISH: 'dropped-too',
    ANTHROPIC_BASE_URL: 'http://example.invalid',
    ANTHROPIC_API_KEY: 'kept-key',
    RANDOM: 'kept',
  };
  const env = sanitizeEnv(REGISTRY['claude-code'], base);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    SLACKISH: 'kept',
    ANTHROPIC_API_KEY: 'kept-key',
    RANDOM: 'kept',
  });
});

test('sanitizeEnv: a CLI preset gets an allowlist, and keeps the key it authenticates with', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/Users/x',
    SLACK_A_USER_TOKEN: 'xoxp-nope',
    ANTHROPIC_API_KEY: 'pi-needs-this',
    OPENAI_API_KEY: 'and-this',
    COPILOT_DB_PATH: '/tmp/data.db',
    PORT: '5252',
    PI_SESSION: 'nested-marker',
    RANDOM: 'not-pis-business',
  };
  const env = sanitizeEnv(REGISTRY['pi'], base);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/Users/x',
    ANTHROPIC_API_KEY: 'pi-needs-this',
    OPENAI_API_KEY: 'and-this',
  });
  // Codex's own deny list must not strip Pi's key, and vice versa — hence per-provider.
  const codexEnv = sanitizeEnv(REGISTRY['codex'], base);
  assert.equal(codexEnv.OPENAI_API_KEY, 'and-this');
  assert.equal('ANTHROPIC_API_KEY' in codexEnv, false, 'not on codex\'s allowlist');
});

test('sanitizeEnv: SLACK_* is dropped even when a provider tries to allow it', () => {
  const env = sanitizeEnv(
    { mode: 'allowlist', deny: [], allow: ['SLACK_A_USER_TOKEN', 'OPENAI_API_KEY'] },
    { SLACK_A_USER_TOKEN: 'xoxp-nope', OPENAI_API_KEY: 'ok' },
  );
  assert.deepEqual(env, { OPENAI_API_KEY: 'ok' });
});

// ---------------------------------------------------------------------------
// session planning
// ---------------------------------------------------------------------------

test('planSession: the truth table across capability combinations', () => {
  const both = makeFakeHarness({ id: 'both-fake' }).provider;
  const resumeOnly = makeFakeHarness({ id: 'resume-only-fake', forkSession: false }).provider;
  const neither = makeFakeHarness({
    id: 'neither-fake',
    resumeSession: false,
    forkSession: false,
  }).provider;

  assert.deepEqual(planSession(both, 'ours', 'theirs'), { mode: 'resume', id: 'ours' });
  assert.deepEqual(planSession(both, null, 'theirs'), { mode: 'fork', id: 'theirs' });
  assert.deepEqual(planSession(both, null, null), { mode: 'seed', id: null });

  assert.deepEqual(planSession(resumeOnly, 'ours', 'theirs'), { mode: 'resume', id: 'ours' });
  // No fork ⇒ SEED, never resume the analyzer's session: appending chat turns there
  // would poison the seed every future fresh chat starts from.
  assert.deepEqual(planSession(resumeOnly, null, 'theirs'), { mode: 'seed', id: null });

  assert.deepEqual(planSession(neither, 'ours', 'theirs'), { mode: 'seed', id: null });
  assert.deepEqual(planSession(neither, null, null), { mode: 'seed', id: null });
});

test('claude-code plans exactly what the app has always done', () => {
  const cc = REGISTRY['claude-code'];
  assert.deepEqual(planSession(cc, 'ours', 'theirs'), { mode: 'resume', id: 'ours' });
  assert.deepEqual(planSession(cc, null, 'analyzer-session'), { mode: 'fork', id: 'analyzer-session' });
  assert.deepEqual(planSession(cc, null, null), { mode: 'seed', id: null });
});

// ---------------------------------------------------------------------------
// status and limitations
// ---------------------------------------------------------------------------

test('/api/status describes the harness, its posture and what it cannot do', async () => {
  await harnessReadiness(REGISTRY['claude-code'], { force: true });
  const status = harnessStatus(REGISTRY['claude-code']);
  assert.equal(status.id, 'claude-code');
  assert.equal(status.label, 'Claude Code');
  assert.equal(status.available, true);
  assert.equal(status.capabilities.tools, 'read-only');
  assert.equal(status.capabilities.safetyProof, 'passed');
  assert.equal(status.capabilities.billing, 'subscription');
  assert.deepEqual(status.limitations, [], 'the default harness has no degradations');
  assert.match(String(status.checkedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('limitations are generated from capabilities, in plain English', () => {
  const limits = limitationsFor(REGISTRY['pi']);
  assert.ok(limits.some((l) => /No calendar, email or task context/.test(l)));
  assert.ok(limits.some((l) => /charges your own AI account/.test(l)));
  for (const line of [...limits, ...limitationsFor(REGISTRY['codex'])]) {
    assert.doesNotMatch(line, /\bMCP\b|\bSDK\b|\bAPI\b|\bsession\b/i, `jargon in: ${line}`);
  }
  const codex = limitationsFor(REGISTRY['codex']);
  assert.ok(codex.some((l) => /all at once/.test(l)), 'no streaming is a user-visible fact');
});

// ---------------------------------------------------------------------------
// the presets — data, checked as data
// ---------------------------------------------------------------------------

test('pi: argv carries the safety flag on every run, and the prompt never appears in it', () => {
  const req = {
    purpose: 'analysis' as const,
    session: { mode: 'seed' as const, id: null },
    prompt: 'SECRET SLACK TEXT',
  };
  const seed = PI.args(req as never);
  assert.deepEqual(seed, ['--mode', 'json', '--no-tools']);
  assert.equal(PI.promptVia, 'stdin', 'argv is world-readable in `ps`');
  assert.equal(seed.includes('SECRET SLACK TEXT'), false);

  assert.deepEqual(
    PI.args({ ...req, session: { mode: 'resume', id: 'abc' } } as never),
    ['--mode', 'json', '--no-tools', '--session', 'abc'],
  );
  assert.deepEqual(
    PI.args({ ...req, session: { mode: 'fork', id: 'abc' } } as never),
    ['--mode', 'json', '--no-tools', '--fork', 'abc'],
  );
  assert.deepEqual(
    PI.args({ ...req, model: 'haiku' } as never),
    ['--mode', 'json', '--no-tools', '--model', 'haiku'],
  );
  assert.equal(PI.capabilities.tools.mode, 'no-tools');
  assert.equal(PI.authCommand, 'pi /login');
  assert.match(PI.installCommand, /--ignore-scripts/);
});

test('codex: every run is sandboxed read-only, with the user config and web search off', () => {
  const argv = CODEX.args({
    purpose: 'analysis',
    session: { mode: 'seed', id: null },
  } as never);
  assert.equal(argv[0], 'exec');
  assert.equal(argv[argv.length - 1], '-', 'the prompt goes over stdin');
  for (const flag of ['--sandbox', 'read-only', '--ignore-user-config', '--skip-git-repo-check']) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.ok(argv.includes('features.web_search=false'));
  assert.ok(argv.includes('--ephemeral'), 'a background analysis must not persist a rollout');
  assert.equal(
    CODEX.args({ purpose: 'chat', session: { mode: 'seed', id: null } } as never).includes('--ephemeral'),
    false,
  );
  // Never the escape hatches.
  const dangerous = ['workspace-write', 'danger-full-access', '--full-auto', '--approve'];
  for (const flag of dangerous) assert.equal(argv.includes(flag), false, `codex passed ${flag}`);
  assert.equal(CODEX.capabilities.tools.mode, 'no-tools');
  assert.equal(CODEX.authCommand, 'codex login');
});

test('a preset that cannot be found reports it in plain English, with a fix command', async () => {
  // pi/codex are not installed on this machine: availability, not a crash.
  for (const id of ['pi', 'codex']) {
    const provider = REGISTRY[id];
    const availability = await provider.available({ PATH: '/nonexistent' });
    assert.equal(availability.ok, false, id);
    assert.match(String(availability.message), /is not installed on this Mac\./);
    assert.equal(availability.command, id === 'pi' ? PI.installCommand : CODEX.installCommand);
    assert.doesNotMatch(String(availability.message), /ENOENT|spawn|PATH/);
  }
});

// ---------------------------------------------------------------------------
// dialects — the part that makes a new harness config rather than code
// ---------------------------------------------------------------------------

test('readPath: the tiny path language', () => {
  const obj = {
    a: { b: { c: 1 } },
    items: [{ text: 'first' }, { text: 'last' }],
    content: [{ text: 'x' }, { type: 'tool_use' }, { text: 'y' }],
    isError: true,
  };
  assert.equal(readPath(obj, 'a.b.c'), 1);
  assert.equal(readPath(obj, 'items[-1].text'), 'last');
  assert.equal(readPath(obj, 'items[0].text'), 'first');
  assert.equal(readPath(obj, 'content[].text'), 'xy');
  assert.equal(readPath(obj, '!isError'), false);
  assert.equal(readPath(obj, 'nope.nothing'), undefined);
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(matches(obj, { 'a.b.c': 1 }), true);
  assert.equal(matches(obj, { 'a.b.c': 2 }), false);
});

test('pi-json: one JSONL line at a time becomes one HarnessEvent', () => {
  const d = EVENT_DIALECTS['pi-json'];
  assert.deepEqual(mapEvent({ type: 'session', id: 'sess-9' }, d), [{ type: 'session', id: 'sess-9' }]);
  assert.deepEqual(
    mapEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }, d),
    [{ type: 'text', delta: 'hi' }],
  );
  assert.deepEqual(
    mapEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking', delta: 'no' } }, d),
    [],
    'only text deltas become text',
  );
  assert.deepEqual(mapEvent({ type: 'tool_execution_start', toolName: 'calendar' }, d), [
    { type: 'tool', name: 'calendar', phase: 'start' },
  ]);
  assert.deepEqual(mapEvent({ type: 'tool_execution_end', toolName: 'calendar', isError: false }, d), [
    { type: 'tool', name: 'calendar', phase: 'end', ok: true },
  ]);
  assert.deepEqual(
    mapEvent({ type: 'agent_end', messages: [{ content: [{ text: '{"urgency":"P2"}' }] }] }, d),
    [{ type: 'result', text: '{"urgency":"P2"}', usage: null }],
  );
  assert.deepEqual(mapEvent({ type: 'something_else' }, d), []);
});

test('claude-stream-json and codex-jsonl map their own shapes', () => {
  assert.deepEqual(
    mapEvent({ type: 'system', subtype: 'init', session_id: 'abc' }, EVENT_DIALECTS['claude-stream-json']),
    [{ type: 'session', id: 'abc' }],
  );
  assert.deepEqual(
    mapEvent(
      { type: 'result', subtype: 'success', result: '{"urgency":"P0"}', total_cost_usd: 0.5 },
      EVENT_DIALECTS['claude-stream-json'],
    ),
    [{ type: 'result', text: '{"urgency":"P0"}', usage: { costUsd: 0.5, inputTokens: null, outputTokens: null } }],
  );
  assert.deepEqual(
    mapEvent({ type: 'thread.started', thread_id: 't1' }, EVENT_DIALECTS['codex-jsonl']),
    [{ type: 'session', id: 't1' }],
  );
});

test('the "text" dialect maps nothing: stdout is buffered and emitted once', () => {
  assert.deepEqual(mapEvent({ type: 'anything' }, EVENT_DIALECTS['text']), []);
  assert.equal(CODEX.dialect, 'text', 'codex ships on the floor until its events are pinned to bytes');
  assert.equal(
    CODEX.capabilities.streaming,
    false,
    'a preset must not claim streaming its dialect cannot deliver',
  );
  assert.equal(
    CODEX.capabilities.resumeSession,
    false,
    'nor claim resume when it never learns a session id',
  );
});

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

test('copyFor: with Claude the strings are byte-identical to the old hard-coded table', () => {
  const claude = (kind: Parameters<typeof copyFor>[0]): Record<string, string> => {
    const c = copyFor(kind, { name: 'Claude', command: kind === 'auth' ? 'claude auth login' : null });
    return { message: c.message, hint: c.hint };
  };
  assert.deepEqual(claude('auth'), {
    message: "Claude isn't signed in on this Mac",
    hint: 'Open Terminal and run: claude auth login',
  });
  assert.deepEqual(claude('timeout'), {
    message: 'Claude took too long to review a message',
    hint: 'It will try again on its own in a few minutes. If every message stalls, quit and reopen the app.',
  });
  assert.deepEqual(claude('rate_limit'), {
    message: 'Claude is temporarily busy and asked us to slow down',
    hint: 'This usually clears by itself within a few minutes. Nothing for you to do.',
  });
  assert.deepEqual(claude('budget'), {
    message: "Claude's usage limit for this plan has been reached",
    hint: 'Prioritizing starts again when the limit resets, or on a higher Claude plan.',
  });
  assert.deepEqual(claude('bad_output'), {
    message: "Claude's answer came back in a form this app could not read",
    hint: 'Usually a one-off. It retries in a few minutes, or press Re-analyze on the message.',
  });
  assert.deepEqual(claude('unknown'), {
    message: "Claude couldn't review this message",
    hint: 'It will try again in a few minutes. If it keeps happening, quit and reopen the app.',
  });
});

test('copyFor: another harness gets its own name and its own command', () => {
  assert.deepEqual(copyFor('auth', { name: 'Codex', command: 'codex login' }), {
    message: "Codex isn't signed in on this Mac",
    hint: 'Open Terminal and run: codex login',
  });
  assert.deepEqual(copyFor('auth', { name: 'Pi', command: null }), {
    message: "Pi isn't signed in on this Mac",
    hint: 'Sign in to Pi on this Mac, then come back here.',
  });
  // Still no jargon, whichever harness is running.
  const banned = /\bOAuth\b|\bSDK\b|\btoken\b|\bdaemon\b|\bstderr\b|\bsubprocess\b/i;
  for (const kind of ['auth', 'timeout', 'rate_limit', 'budget', 'bad_output', 'unknown'] as const) {
    const c = copyFor(kind, { name: 'Pi', command: 'pi /login' });
    assert.doesNotMatch(c.message, banned);
    assert.doesNotMatch(c.hint, banned);
  }
});
