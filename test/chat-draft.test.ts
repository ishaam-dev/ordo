/**
 * CHARACTERIZATION — src/chat.ts draft protocol and the small pure helpers around it.
 *
 * THE INVARIANT THAT MATTERS: anything malformed degrades to plain prose and produces
 * NO draft. A draft is the only thing the UI offers a "send to Slack" button for, so a
 * mis-parsed turn must never manufacture one.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { DB_PATH } = await import('../src/db.js');
assertIsolated(DB_PATH);

const {
  parseAssistantText,
  serializeHistory,
  messagesAfter,
  destinationFor,
  toolLabel,
  textFromContent,
  kindOfAssistantError,
} = await import('../src/chat.js');

/** Every malformed input must produce zero drafts and keep its text visible. */
function assertDegradesToProse(raw: string): void {
  const out = parseAssistantText(raw);
  assert.deepEqual(out.drafts, [], `expected no drafts for ${JSON.stringify(raw)}`);
  assert.ok(out.text.length > 0, `expected the prose to survive for ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// well-formed drafts
// ---------------------------------------------------------------------------

test('a closed ```draft block is lifted out of the prose', () => {
  assert.deepEqual(parseAssistantText('Here you go:\n```draft\nHi Bob\n```\nThat ok?'), {
    text: 'Here you go:\nThat ok?',
    drafts: ['Hi Bob'],
  });
});

test('a draft block on its own leaves empty prose', () => {
  assert.deepEqual(parseAssistantText('```draft\nonly\n```'), { text: '', drafts: ['only'] });
});

test('tilde fences work too', () => {
  assert.deepEqual(parseAssistantText('x\n~~~draft\nbody\n~~~\ny'), { text: 'x\ny', drafts: ['body'] });
});

test('fences longer than three characters work', () => {
  assert.deepEqual(parseAssistantText('x\n`````draft\nbody\n`````\ny'), { text: 'x\ny', drafts: ['body'] });
});

test('the closing fence may be longer than the opening one, never shorter', () => {
  assert.deepEqual(parseAssistantText('x\n```draft\nbody\n````\ny').drafts, ['body']);
  // 4 backticks opened, 3 closed → never closes → prose.
  assertDegradesToProse('x\n````draft\nbody\n```\ny');
});

test('the draft tag is case-insensitive', () => {
  for (const tag of ['draft', 'DRAFT', 'Draft', 'dRaFt']) {
    assert.deepEqual(parseAssistantText('```' + tag + '\nbody\n```').drafts, ['body'], tag);
  }
});

test('trailing junk after the tag is tolerated on the opening fence', () => {
  assert.deepEqual(parseAssistantText('```draft title=reply\nbody\n```').drafts, ['body']);
  assert.deepEqual(parseAssistantText('```draft   \nbody\n```').drafts, ['body']);
});

test('"draft" must be a whole word: ```drafty is not a draft', () => {
  assertDegradesToProse('```drafty\nbody\n```');
  assertDegradesToProse('```mydraft\nbody\n```');
});

test('a fence indented up to 3 spaces opens; 4 spaces is a code block, not a fence', () => {
  assert.deepEqual(parseAssistantText('   ```draft\n   body\n   ```').drafts, ['body']);
  assertDegradesToProse('    ```draft\n    body\n    ```');
});

test('the closing fence may carry trailing whitespace but not trailing text', () => {
  assert.deepEqual(parseAssistantText('x\n```draft\nbody\n```   \ny').drafts, ['body']);
  assertDegradesToProse('x\n```draft\nbody\n``` end\ny');
});

test('a tilde fence is not closed by a backtick fence', () => {
  assertDegradesToProse('x\n~~~draft\nbody\n```\ny');
});

test('a longer fence can wrap an inner code block', () => {
  assert.deepEqual(parseAssistantText('x\n````draft\n```\ncode\n```\n````\ny'), {
    text: 'x\ny',
    drafts: ['```\ncode\n```'],
  });
});

test('draft bodies are trimmed and multi-line bodies survive intact', () => {
  assert.deepEqual(parseAssistantText('```draft\n\n  line one\nline two  \n\n```').drafts, [
    'line one\nline two',
  ]);
});

test('multiple drafts come back in the order the model produced them', () => {
  assert.deepEqual(parseAssistantText('a\n```draft\none\n```\nb\n```draft\ntwo\n```\nc'), {
    text: 'a\nb\nc',
    drafts: ['one', 'two'],
  });
});

// ---------------------------------------------------------------------------
// malformed input degrades to prose — the safety invariant
// ---------------------------------------------------------------------------

test('an unclosed draft fence stays prose, verbatim, to the end of the turn', () => {
  const out = parseAssistantText('before\n```draft\nbody never closed');
  assert.deepEqual(out.drafts, []);
  assert.equal(out.text, 'before\n```draft\nbody never closed');
});

test('an untagged fence is never a draft', () => {
  const out = parseAssistantText('before\n```\nbody\n```\nafter');
  assert.deepEqual(out.drafts, []);
  assert.equal(out.text, 'before\n```\nbody\n```\nafter');
});

test('a ```json / ```text fence is never a draft', () => {
  assertDegradesToProse('```json\n{"a":1}\n```');
  assertDegradesToProse('```text\nhello\n```');
});

test('an unclosed fence after a good draft keeps the good draft and prose-ifies the rest', () => {
  const out = parseAssistantText('```draft\ngood\n```\ntail\n```draft\nnever closed');
  assert.deepEqual(out.drafts, ['good']);
  assert.equal(out.text, 'tail\n```draft\nnever closed');
});

test('an empty draft body produces no draft at all', () => {
  assert.deepEqual(parseAssistantText('x\n```draft\n\n```\ny'), { text: 'x\ny', drafts: [] });
  assert.deepEqual(parseAssistantText('```draft\n   \n```'), { text: '', drafts: [] });
});

test('empty and non-string input are safe', () => {
  assert.deepEqual(parseAssistantText(''), { text: '', drafts: [] });
  assert.deepEqual(parseAssistantText(undefined as unknown as string), { text: '', drafts: [] });
  assert.deepEqual(parseAssistantText(null as unknown as string), { text: '', drafts: [] });
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test('at most 3 drafts are kept per turn; the extras vanish entirely', () => {
  const raw = [1, 2, 3, 4, 5].map((n) => '```draft\n' + n + '\n```').join('\n');
  const out = parseAssistantText(raw);
  assert.deepEqual(out.drafts, ['1', '2', '3']);
  // QUIRK: drafts 4 and 5 are dropped from `drafts` *and* removed from the prose, so the
  // user never sees them at all.
  assert.equal(out.text, '');
});

test('a draft body is hard-truncated at 4000 characters (no ellipsis)', () => {
  const out = parseAssistantText('```draft\n' + 'z'.repeat(4_100) + '\n```');
  assert.equal(out.drafts[0].length, 4_000);
  assert.equal(out.drafts[0], 'z'.repeat(4_000));
  const exact = parseAssistantText('```draft\n' + 'z'.repeat(4_000) + '\n```');
  assert.equal(exact.drafts[0].length, 4_000);
});

test('blank runs left by a lifted block are collapsed to one blank line', () => {
  assert.equal(parseAssistantText('a\n\n\n\n\nb').text, 'a\n\nb');
  assert.equal(parseAssistantText('a\n\n```draft\nd\n```\n\nb').text, 'a\n\nb');
  assert.equal(parseAssistantText('\n\n  hi  \n\n').text, 'hi');
});

// ---------------------------------------------------------------------------
// stored history uses the same parser as the live stream
// ---------------------------------------------------------------------------

test('serializeHistory parses assistant rows only; user/error rows stay verbatim', () => {
  const rows = [
    { id: 1, role: 'user', text: '```draft\nx\n```', created_at: 't1' },
    { id: 2, role: 'assistant', text: 'hi\n```draft\nx\n```', created_at: 't2' },
    { id: 3, role: 'error', text: "Claude isn't signed in on this Mac", created_at: null },
    { id: 4, role: 'sent', text: 'https://slack.example/p1', created_at: 't4' },
    { id: 5, role: 'assistant', text: null, created_at: 't5' },
  ];
  assert.deepEqual(serializeHistory(rows as Parameters<typeof serializeHistory>[0]), [
    { id: 1, role: 'user', at: 't1', text: '```draft\nx\n```', drafts: [] },
    { id: 2, role: 'assistant', at: 't2', text: 'hi', drafts: ['x'] },
    { id: 3, role: 'error', at: null, text: "Claude isn't signed in on this Mac", drafts: [] },
    { id: 4, role: 'sent', at: 't4', text: 'https://slack.example/p1', drafts: [] },
    { id: 5, role: 'assistant', at: 't5', text: '', drafts: [] },
  ]);
});

// ---------------------------------------------------------------------------
// the send destination — a DM must never post with a fabricated thread_ts
// ---------------------------------------------------------------------------

const thread = (over: Record<string, unknown>): Parameters<typeof destinationFor>[0] =>
  ({
    id: 1,
    workspace: 'A',
    team_name: 'Acme',
    channel_id: 'D123',
    channel_name: 'Ruby Valderrama',
    thread_ts: 'D123',
    kind: 'dm',
    status: 'new',
    last_activity: '1.1',
    permalink: null,
    ...over,
  }) as Parameters<typeof destinationFor>[0];

test('destinationFor: a DM posts to the conversation with NO thread_ts', () => {
  assert.deepEqual(destinationFor(thread({})), {
    label: 'Ruby Valderrama',
    kind: 'dm',
    workspace: 'A',
    team_name: 'Acme',
    channel_id: 'D123',
    thread_ts: null,
  });
});

test('destinationFor: a channel mention keeps its real thread_ts and a #-prefixed label', () => {
  assert.deepEqual(
    destinationFor(thread({ kind: 'mention', channel_id: 'C9', channel_name: 'dream-team', thread_ts: '1700.0001' })),
    {
      label: '#dream-team',
      kind: 'mention',
      workspace: 'A',
      team_name: 'Acme',
      channel_id: 'C9',
      thread_ts: '1700.0001',
    },
  );
});

test('destinationFor: an unresolved channel name falls back to the channel id', () => {
  assert.equal(destinationFor(thread({ channel_name: null })).label, 'D123');
  assert.equal(destinationFor(thread({ kind: 'mention', channel_name: null, channel_id: 'C9' })).label, '#C9');
});

// ---------------------------------------------------------------------------
// resume-delta selection
// ---------------------------------------------------------------------------

const rows = [
  { id: 1, thread_id: 1, ts: '100.500000', author_id: null, author_name: null, text: 'a', raw: null },
  { id: 2, thread_id: 1, ts: '200.000000', author_id: null, author_name: null, text: 'b', raw: null },
];

test('messagesAfter: no cover, empty cover or an unparseable cover returns everything', () => {
  assert.equal(messagesAfter(rows, null).length, 2);
  assert.equal(messagesAfter(rows, '').length, 2);
  assert.equal(messagesAfter(rows, 'not-a-ts').length, 2);
});

test('messagesAfter: the covered message itself is excluded (0.0001s of slack)', () => {
  assert.deepEqual(messagesAfter(rows, '100.500000').map((m) => m.ts), ['200.000000']);
  assert.deepEqual(messagesAfter(rows, '100.500050').map((m) => m.ts), ['200.000000']);
  assert.deepEqual(messagesAfter(rows, '200.000000'), []);
});

// ---------------------------------------------------------------------------
// harness-message helpers (these are Claude-Code shaped — see the report)
// ---------------------------------------------------------------------------

test('toolLabel: mcp__server__tool becomes "server · tool"', () => {
  assert.equal(toolLabel('mcp__calendar__list_events'), 'calendar · list_events');
  assert.equal(toolLabel('mcp__a__b__c'), 'a · b__c');
  assert.equal(toolLabel('Read'), 'Read'); // fewer than 3 parts: unchanged
  assert.equal(toolLabel('a__b'), 'a__b');
});

test('textFromContent: concatenates text blocks and ignores everything else', () => {
  assert.equal(textFromContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(textFromContent([]), '');
  assert.equal(textFromContent('not an array'), '');
  assert.equal(textFromContent(null), '');
  assert.equal(textFromContent([{ type: 'text', text: 42 }]), '');
});

test('kindOfAssistantError maps structural error codes to failure buckets', () => {
  assert.equal(kindOfAssistantError('authentication_failed'), 'auth');
  assert.equal(kindOfAssistantError('oauth_org_not_allowed'), 'auth');
  assert.equal(kindOfAssistantError('billing_error'), 'budget');
  assert.equal(kindOfAssistantError('rate_limit'), 'rate_limit');
  assert.equal(kindOfAssistantError('overloaded'), 'rate_limit');
  assert.equal(kindOfAssistantError('max_output_tokens'), 'bad_output');
  assert.equal(kindOfAssistantError('something_new'), 'unknown');
  assert.equal(kindOfAssistantError(''), 'unknown');
});
