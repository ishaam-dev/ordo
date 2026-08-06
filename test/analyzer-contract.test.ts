/**
 * CHARACTERIZATION — src/analyzer.ts, the model-output contract.
 *
 * These tests pin what the code does TODAY, quirks included, so the pluggable-harness
 * refactor can move this logic around and still prove it behaves identically. Nothing
 * here talks to Slack or to any AI harness: every function under test is pure.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { DB_PATH } = await import('../src/db.js');
assertIsolated(DB_PATH);

const {
  extractJsonObject,
  asCappedString,
  parseAnalysis,
  isToolAllowed,
  sanitizedEnv,
  buildTranscript,
  buildPrompt,
  DISALLOWED_BUILTIN_TOOLS,
} = await import('../src/analyzer.js');
const chat = await import('../src/chat.js');

type Msg = Parameters<typeof buildTranscript>[0][number];
const msg = (
  ts: string,
  authorId: string | null,
  authorName: string | null,
  text: string | null,
): Msg => ({ id: 0, thread_id: 1, ts, author_id: authorId, author_name: authorName, text, raw: null });

const thread = (over: Record<string, unknown> = {}): Parameters<typeof buildPrompt>[0] =>
  ({
    id: 1,
    workspace: 'A',
    team_name: 'Acme',
    channel_id: 'C1',
    channel_name: 'general',
    thread_ts: '1700000000.000100',
    kind: 'mention',
    status: 'new',
    last_activity: '1700000000.000100',
    permalink: null,
    ...over,
  }) as Parameters<typeof buildPrompt>[0];

// ---------------------------------------------------------------------------
// JSON extraction — the balanced-brace scan
// ---------------------------------------------------------------------------

test('extractJsonObject: bare object', () => {
  assert.deepEqual(extractJsonObject('{"urgency":"P1","why":"x"}'), { urgency: 'P1', why: 'x' });
});

test('extractJsonObject: tolerates a ```json fence around the object', () => {
  assert.deepEqual(extractJsonObject('```json\n{"urgency":"P0"}\n```'), { urgency: 'P0' });
  assert.deepEqual(extractJsonObject('```\n{"urgency":"P0"}\n```'), { urgency: 'P0' });
});

test('extractJsonObject: tolerates prose before and after', () => {
  assert.deepEqual(
    extractJsonObject('Here is my verdict.\n\n{"urgency":"P2"}\n\nHope that helps!'),
    { urgency: 'P2' },
  );
});

test('extractJsonObject: leading whitespace and a stray closing brace are skipped', () => {
  // indexOf('{') finds the first *opening* brace, so junk before it is simply ignored.
  assert.deepEqual(extractJsonObject('   \n}{"a":1}'), { a: 1 });
});

test('extractJsonObject: nested braces are balanced, not first-close', () => {
  assert.deepEqual(extractJsonObject('{"a":{"b":{"c":1}},"d":2}'), { a: { b: { c: 1 } }, d: 2 });
});

test('extractJsonObject: braces and escapes inside strings do not confuse the scan', () => {
  assert.deepEqual(extractJsonObject('{"why":"a } b {","x":1}'), { why: 'a } b {', x: 1 });
  assert.deepEqual(extractJsonObject('{"why":"say \\"hi\\" }","x":1}'), { why: 'say "hi" }', x: 1 });
  assert.deepEqual(extractJsonObject('{"why":"back\\\\","x":1}'), { why: 'back\\', x: 1 });
});

test('extractJsonObject: multiple objects — the FIRST balanced one wins', () => {
  assert.deepEqual(extractJsonObject('{"a":1} {"b":2}'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"urgency":"P0"}\n{"urgency":"P3"}'), { urgency: 'P0' });
});

test('extractJsonObject: QUIRK — a JSON array yields its first element, not an error', () => {
  // The scan starts at the first '{', which is inside the array, so the array wrapper is
  // silently discarded instead of being rejected as "not an object".
  assert.deepEqual(extractJsonObject('[{"urgency":"P1"},{"urgency":"P2"}]'), { urgency: 'P1' });
});

test('extractJsonObject: QUIRK — a brace quoted in the prose derails the scan', () => {
  // The scan begins AT that '{' with inString=false, so the prose string''s closing quote
  // opens a string that swallows the rest of the text.
  assert.throws(
    () => extractJsonObject('He typed "{" first. {"urgency":"P1"}'),
    /unbalanced JSON object in result/,
  );
});

test('extractJsonObject: empty object is valid', () => {
  assert.deepEqual(extractJsonObject('{}'), {});
});

test('extractJsonObject: failure messages are exact (health.ts matches on them)', () => {
  assert.throws(() => extractJsonObject('no braces at all'), /^Error: no JSON object found in result$/);
  assert.throws(() => extractJsonObject('{"urgency":"P0", "why":"x'), /^Error: unbalanced JSON object in result$/);
  assert.throws(() => extractJsonObject('{oops}'), /^Error: result JSON failed to parse$/);
  assert.throws(() => extractJsonObject('{"a":1,}'), /^Error: result JSON failed to parse$/);
  assert.throws(() => extractJsonObject(''), /^Error: no JSON object found in result$/);
});

// ---------------------------------------------------------------------------
// urgency validation
// ---------------------------------------------------------------------------

for (const u of ['P0', 'P1', 'P2', 'P3'] as const) {
  test(`parseAnalysis: accepts urgency ${u}`, () => {
    assert.equal(parseAnalysis(`{"urgency":"${u}"}`).urgency, u);
  });
}

test('parseAnalysis: urgency is upper-cased and trimmed before validation', () => {
  assert.equal(parseAnalysis('{"urgency":"p1"}').urgency, 'P1');
  assert.equal(parseAnalysis('{"urgency":" p2 "}').urgency, 'P2');
  assert.equal(parseAnalysis('{"urgency":"\\tP3\\n"}').urgency, 'P3');
});

for (const bad of ['P4', 'P', '', 'p0x', 'PO', 'critical', '0']) {
  test(`parseAnalysis: rejects urgency ${JSON.stringify(bad)}`, () => {
    assert.throws(
      () => parseAnalysis(JSON.stringify({ urgency: bad })),
      /result urgency is not one of P0\.\.P3/,
    );
  });
}

test('parseAnalysis: rejects a missing / null / non-string urgency', () => {
  assert.throws(() => parseAnalysis('{"why":"w"}'), /urgency is not one of/);
  assert.throws(() => parseAnalysis('{"urgency":null}'), /urgency is not one of/);
  assert.throws(() => parseAnalysis('{"urgency":0}'), /urgency is not one of/);
  assert.throws(() => parseAnalysis('{"urgency":true}'), /urgency is not one of/);
});

test('parseAnalysis: QUIRK — a one-element array urgency is accepted', () => {
  // String(["P1"]) === "P1", so the value survives validation.
  assert.equal(parseAnalysis('{"urgency":["P1"]}').urgency, 'P1');
  assert.throws(() => parseAnalysis('{"urgency":["P1","P2"]}'), /urgency is not one of/);
});

test('parseAnalysis: maps snake_case JSON onto camelCase fields', () => {
  const parsed = parseAnalysis(
    '{"urgency":"P1","why":"w","summary":"s","suggested_action":"a","context_notes":"- [calendar] busy"}',
  );
  assert.deepEqual(parsed, {
    urgency: 'P1',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '- [calendar] busy',
  });
});

test('parseAnalysis: missing optional fields become empty strings, never undefined', () => {
  const parsed = parseAnalysis('{"urgency":"P3"}');
  assert.deepEqual(parsed, {
    urgency: 'P3',
    why: '',
    summary: '',
    suggestedAction: '',
    contextNotes: '',
  });
});

// ---------------------------------------------------------------------------
// field truncation caps
// ---------------------------------------------------------------------------

test('asCappedString: coercion rules', () => {
  assert.equal(asCappedString('  hi  ', 100), 'hi'); // trimmed
  assert.equal(asCappedString(['a', 'b'], 100), 'a\nb'); // arrays join on newline
  assert.equal(asCappedString(null, 100), '');
  assert.equal(asCappedString(undefined, 100), '');
  assert.equal(asCappedString(12, 100), '12');
  assert.equal(asCappedString(true, 100), 'true');
  assert.equal(asCappedString({ a: 1 }, 100), '[object Object]'); // QUIRK: no JSON stringify
});

test('asCappedString: at the cap it is untouched, over the cap it ends in an ellipsis', () => {
  assert.equal(asCappedString('abcde', 5), 'abcde');
  assert.equal(asCappedString('abcdef', 5), 'abcd…');
  assert.equal(asCappedString('abcdef', 5).length, 5); // ellipsis replaces the last kept char
  assert.equal(asCappedString([1, 2, 3], 3), '1\n…');
});

test('parseAnalysis: per-field caps are 160 / 1200 / 300 / 2000', () => {
  const parsed = parseAnalysis(
    JSON.stringify({
      urgency: 'P1',
      why: 'w'.repeat(500),
      summary: 's'.repeat(5000),
      suggested_action: 'a'.repeat(5000),
      context_notes: 'n'.repeat(5000),
    }),
  );
  assert.equal(parsed.why.length, 160);
  assert.equal(parsed.summary.length, 1_200);
  assert.equal(parsed.suggestedAction.length, 300);
  assert.equal(parsed.contextNotes.length, 2_000);
  for (const v of [parsed.why, parsed.summary, parsed.suggestedAction, parsed.contextNotes]) {
    assert.ok(v.endsWith('…'));
  }
});

test('parseAnalysis: a value exactly at the cap keeps every character', () => {
  const parsed = parseAnalysis(JSON.stringify({ urgency: 'P1', why: 'w'.repeat(160) }));
  assert.equal(parsed.why, 'w'.repeat(160));
});

// ---------------------------------------------------------------------------
// read-only tool enforcement — SECURITY. Must survive the refactor unchanged.
// ---------------------------------------------------------------------------

const ALLOWED_TOOL_NAMES = [
  'mcp__calendar__list_events',
  'mcp__gmail__search_threads',
  'mcp__x__read_file',
  'mcp__x__get_thread',
  'mcp__x__download_file', // no mutation word inside "download"
  'mcp__x__descendant', // "scend", not "send"
  'mcp__x__compose', // "compose" does not contain "post"
  'mcp__x__get_calendar',
];

const DENIED_TOOL_NAMES = [
  // built-ins: everything without the mcp__ prefix
  'Read',
  'Bash',
  'Write',
  'WebFetch',
  'Task',
  'SlashCommand',
  '',
  'notmcp__x__list',
  'MCP__x__list', // QUIRK: the prefix check is case-SENSITIVE
  ' mcp__x__list', // leading space defeats startsWith
  // mutation words
  'mcp__gmail__create_draft',
  'mcp__slack__slack_send_message',
  'mcp__slack__slack_post_message',
  'mcp__x__update_row',
  'mcp__x__delete_row',
  'mcp__x__write_note',
  'mcp__x__add_item',
  'mcp__x__remove_item',
  'mcp__x__archive_thing',
  'mcp__x__label_message',
  'mcp__x__list_drafts',
  'mcp__x__schedule_meeting',
  'mcp__x__respond_to_event',
  'mcp__x__submit_form',
];

test('isToolAllowed: MCP-only allowlist plus the mutation-name deny list', () => {
  for (const name of ALLOWED_TOOL_NAMES) {
    assert.equal(isToolAllowed(name), true, `expected ALLOWED: ${name}`);
  }
  for (const name of DENIED_TOOL_NAMES) {
    assert.equal(isToolAllowed(name), false, `expected DENIED: ${name}`);
  }
});

test('isToolAllowed: the mutation-name check is case-insensitive', () => {
  for (const name of [
    'mcp__x__CREATE_thing',
    'mcp__x__SeNdIt',
    'mcp__x__POST_message',
    'mcp__x__Delete',
    'mcp__x__WRITE',
    'mcp__x__UpDaTe',
  ]) {
    assert.equal(isToolAllowed(name), false, `expected DENIED: ${name}`);
  }
});

test('isToolAllowed: QUIRK — substring matching denies innocent near-misses', () => {
  // These are read-only names that happen to contain a mutation word. Denying them is
  // safe-by-default and deliberate ("belt and suspenders"), but it is worth pinning.
  assert.equal(isToolAllowed('mcp__x__list_addresses'), false); // "add"resses
  assert.equal(isToolAllowed('mcp__x__ladder_report'), false); // l"add"er
  assert.equal(isToolAllowed('mcp__x__correspondent_lookup'), false); // corre"spond"…"respond"
  assert.equal(isToolAllowed('mcp__x__get_updates'), false); // "update"s
  assert.equal(isToolAllowed('mcp__x__writer_info'), false); // "write"r
  assert.equal(isToolAllowed('mcp__x__sender_stats'), false); // "send"er
  assert.equal(isToolAllowed('mcp__x__repost_history'), false); // re"post"
});

test('isToolAllowed: QUIRK — the bare prefix "mcp__" is allowed', () => {
  assert.equal(isToolAllowed('mcp__'), true);
  assert.equal(isToolAllowed('mcp__a'), true);
});

test('read-only policy is byte-identical in analyzer.ts and chat.ts', () => {
  // Two copies of the same rule today. The refactor must not let them drift apart.
  for (const name of [...ALLOWED_TOOL_NAMES, ...DENIED_TOOL_NAMES, 'mcp__', 'mcp__x__CREATE']) {
    assert.equal(chat.isToolAllowed(name), isToolAllowed(name), `divergence on ${name}`);
  }
  assert.deepEqual(chat.DISALLOWED_BUILTIN_TOOLS, DISALLOWED_BUILTIN_TOOLS);
});

test('DISALLOWED_BUILTIN_TOOLS is the exact list handed to the harness', () => {
  assert.deepEqual(DISALLOWED_BUILTIN_TOOLS, [
    'Bash',
    'BashOutput',
    'KillShell',
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'Task',
    'Agent',
    'TodoWrite',
    'ExitPlanMode',
    'Skill',
    'SlashCommand',
  ]);
  // Every name on the deny list is also rejected by the permission gate.
  for (const name of DISALLOWED_BUILTIN_TOOLS) assert.equal(isToolAllowed(name), false);
});

// ---------------------------------------------------------------------------
// subprocess env sanitisation — Slack tokens must never reach the harness child
// ---------------------------------------------------------------------------

test('sanitizedEnv: drops SLACK_*, CLAUDE* and ANTHROPIC_BASE_URL, keeps the rest', () => {
  process.env.SLACK_A_USER_TOKEN = 'sentinel-a';
  process.env.SLACK_B_APP_TOKEN = 'sentinel-b';
  process.env.SLACKISH = 'kept';
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  process.env.CLAUDEISH = 'dropped-too';
  process.env.ANTHROPIC_BASE_URL = 'http://example.invalid';
  process.env.ANTHROPIC_API_KEY = 'kept-key';
  try {
    const env = sanitizedEnv();
    // deleted outright — the key is gone, not just blanked
    for (const k of [
      'SLACK_A_USER_TOKEN',
      'SLACK_B_APP_TOKEN',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDEISH',
      'ANTHROPIC_BASE_URL',
    ]) {
      assert.equal(k in env, false, `${k} should have been deleted`);
    }
    // QUIRK: SLACK needs the underscore, CLAUDE does not; the API key is NOT stripped.
    assert.equal(env.SLACKISH, 'kept');
    assert.equal(env.ANTHROPIC_API_KEY, 'kept-key');
    assert.equal(env.PATH, process.env.PATH);
    assert.notEqual(env, process.env); // a copy, not the live object
  } finally {
    for (const k of [
      'SLACK_A_USER_TOKEN',
      'SLACK_B_APP_TOKEN',
      'SLACKISH',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDEISH',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
    ]) {
      delete process.env[k];
    }
  }
});

test('sanitizedEnv is the same policy in analyzer.ts and chat.ts', () => {
  process.env.SLACK_TEST_TOKEN = 'sentinel';
  try {
    assert.equal('SLACK_TEST_TOKEN' in sanitizedEnv(), false);
    assert.equal('SLACK_TEST_TOKEN' in chat.sanitizedEnv(), false);
  } finally {
    delete process.env.SLACK_TEST_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// transcript + prompt shape (tests run with TZ=UTC — see test/helpers/env.ts)
// ---------------------------------------------------------------------------

test('buildTranscript: "[YYYY-MM-DD HH:MM] Author: text" lines', () => {
  const out = buildTranscript([msg('1700000000.000100', 'U1', 'Alice', 'hi')], null);
  assert.equal(out, '[2023-11-14 22:13] Alice: hi');
});

test('buildTranscript: my own lines are marked "(me)"', () => {
  const out = buildTranscript(
    [msg('1700000000.000100', 'UME', 'Me', 'mine'), msg('1700000060.000100', 'U1', 'Alice', 'theirs')],
    'UME',
  );
  assert.equal(out, '[2023-11-14 22:13] Me (me): mine\n[2023-11-14 22:14] Alice: theirs');
});

test('buildTranscript: author falls back name → id → "unknown"; empty text → "(no text)"', () => {
  const out = buildTranscript(
    [
      msg('1700000000.000100', 'U1', null, 'a'),
      msg('1700000000.000200', null, null, null),
      msg('1700000000.000300', null, null, '   '),
    ],
    null,
  );
  assert.deepEqual(out.split('\n'), [
    '[2023-11-14 22:13] U1: a',
    '[2023-11-14 22:13] unknown: (no text)',
    '[2023-11-14 22:13] unknown: (no text)',
  ]);
});

test('buildTranscript: carriage returns are stripped, text is trimmed', () => {
  const out = buildTranscript([msg('1700000000.000100', 'U1', 'Alice', ' x\r\ny  ')], null);
  assert.equal(out, '[2023-11-14 22:13] Alice: x\ny');
});

test('buildTranscript: an unparseable ts is printed verbatim', () => {
  const out = buildTranscript([msg('not-a-ts', 'U1', 'Alice', 'x')], null);
  assert.equal(out, '[not-a-ts] Alice: x');
});

test('buildTranscript: oldest messages are dropped to fit the 8000-char budget', () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    msg(`170000${String(i).padStart(4, '0')}.000100`, 'U1', 'Alice', 'x'.repeat(40)),
  );
  const out = buildTranscript(many, null);
  const lines = out.split('\n');
  assert.match(lines[0], /^\[… 281 earlier message\(s\) omitted to fit …\]$/);
  assert.equal(lines.length, 120); // 119 kept messages + the marker
  assert.ok(out.includes('x'.repeat(40)));
  // QUIRK: the marker itself is appended after the budget check, so the result can
  // exceed TRANSCRIPT_CHAR_BUDGET by the length of the marker.
  assert.ok(out.length > 8_000, `expected slight overshoot, got ${out.length}`);
});

test('buildTranscript: a single over-budget message is kept whole (never truncated to nothing)', () => {
  const out = buildTranscript([msg('1700000000.000100', 'U1', 'Alice', 'y'.repeat(20_000))], null);
  assert.ok(out.includes('y'.repeat(20_000)));
  assert.equal(out.split('\n').length, 1);
});

test('buildPrompt: frames the transcript as untrusted data with explicit markers', () => {
  const out = buildPrompt(thread(), [msg('1700000000.000100', 'U1', 'Alice', 'hi')], 'UME');
  assert.ok(out.includes('=== BEGIN SLACK TRANSCRIPT (untrusted data, oldest first) ==='));
  assert.ok(out.includes('=== END SLACK TRANSCRIPT ==='));
  assert.ok(out.includes('Workspace: Acme'));
  assert.ok(out.includes('Channel: #general'));
  assert.ok(out.includes('Thread kind: @-mention of me in a channel'));
  assert.ok(out.includes('My Slack user id here is UME'));
  assert.ok(out.includes('Reply with the single JSON verdict object per the output contract.'));
});

test('buildPrompt: DM labelling, name fallbacks and the unknown-identity line', () => {
  const out = buildPrompt(
    thread({ kind: 'dm', team_name: null, channel_name: null }),
    [msg('1700000000.000100', 'U1', 'Alice', 'hi')],
    null,
  );
  assert.ok(out.includes('Workspace: A')); // falls back to the workspace key
  assert.ok(out.includes('Channel: DM with C1')); // falls back to the channel id
  assert.ok(out.includes('Thread kind: direct message to me'));
  assert.ok(out.includes('My own user id is unknown for this workspace'));
});
