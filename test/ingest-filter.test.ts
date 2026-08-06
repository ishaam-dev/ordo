/**
 * CHARACTERIZATION — src/ingest.ts keep/drop rules, DM conversation keying, the
 * watch-start behaviour of `historical`, and edit/delete handling.
 *
 * No Slack connection is made: `WorkspaceRuntime.client` is a hand-rolled double, and
 * `ingestMessage` / `handleMessageMutation` are called directly with event payloads
 * shaped like the ones Bolt delivers.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, seedThread, seedMessage, threadRow, messageRows, countRows, raw } from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);
const { ingestMessage, handleMessageMutation, mentionsUser, blocksMentionUser } = await import(
  '../src/ingest.js'
);
type Runtime = Parameters<typeof ingestMessage>[0];

const ME = 'UME';

interface FakeClient {
  calls: string[];
  channelName: string | null;
  permalink: string | null;
  userName: string | null;
  users: { info: (args: { user: string }) => Promise<unknown> };
  conversations: { info: (args: { channel: string }) => Promise<unknown> };
  chat: { getPermalink: (args: { channel: string; message_ts: string }) => Promise<unknown> };
}

function fakeClient(over: Partial<Pick<FakeClient, 'channelName' | 'permalink' | 'userName'>> = {}): FakeClient {
  const c: FakeClient = {
    calls: [],
    channelName: over.channelName === undefined ? 'general' : over.channelName,
    permalink: over.permalink === undefined ? 'https://slack.example/p1' : over.permalink,
    userName: over.userName === undefined ? 'Alice' : over.userName,
    users: {
      info: async ({ user }) => {
        c.calls.push(`users.info:${user}`);
        if (c.userName === null) throw new Error('users.info failed');
        return { user: { profile: { display_name: c.userName } } };
      },
    },
    conversations: {
      info: async ({ channel }) => {
        c.calls.push(`conversations.info:${channel}`);
        if (c.channelName === null) throw new Error('conversations.info failed');
        return { channel: { name: c.channelName } };
      },
    },
    chat: {
      getPermalink: async ({ channel, message_ts }) => {
        c.calls.push(`chat.getPermalink:${channel}/${message_ts}`);
        if (c.permalink === null) throw new Error('getPermalink failed');
        return { permalink: c.permalink };
      },
    },
  };
  return c;
}

function runtime(client: FakeClient = fakeClient()): Runtime & { client: FakeClient } {
  return {
    key: 'A',
    myUserId: ME,
    teamName: 'Acme',
    client,
    userNameCache: new Map<string, string>(),
    metadataRetryAt: new Map<number, number>(),
    watchStart: Number.NEGATIVE_INFINITY,
  } as Runtime & { client: FakeClient };
}

beforeEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// mention detection
// ---------------------------------------------------------------------------

test('mentionsUser: plain <@U>, legacy <@U|name>, and neither', () => {
  assert.equal(mentionsUser({ text: `hey <@${ME}> look` }, ME), true);
  assert.equal(mentionsUser({ text: `hey <@${ME}|isha> look` }, ME), true);
  assert.equal(mentionsUser({ text: 'hey <@UOTHER> look' }, ME), false);
  assert.equal(mentionsUser({ text: `${ME} without the angle brackets` }, ME), false);
  assert.equal(mentionsUser({ text: `<@${ME}xyz>` }, ME), false, 'a longer id is not a match');
  assert.equal(mentionsUser({}, ME), false);
  assert.equal(mentionsUser({ text: 42 }, ME), false);
  assert.equal(mentionsUser(null, ME), false);
});

test('mentionsUser: rich-text clients put the mention only in blocks', () => {
  const ev = {
    text: 'hey  look', // Slack does not always render the mention into text
    blocks: [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: ME }] }] },
    ],
  };
  assert.equal(mentionsUser(ev, ME), true);
  assert.equal(mentionsUser({ ...ev, blocks: [{ type: 'rich_text', elements: [] }] }, ME), false);
});

test('blocksMentionUser: matches {type:"user", user_id} at any shallow depth', () => {
  assert.equal(blocksMentionUser({ type: 'user', user_id: ME }, ME), true);
  assert.equal(blocksMentionUser([{ a: { b: { type: 'user', user_id: ME } } }], ME), true);
  assert.equal(blocksMentionUser({ type: 'user', user_id: 'UOTHER' }, ME), false);
  assert.equal(blocksMentionUser({ type: 'link', user_id: ME }, ME), false);
  assert.equal(blocksMentionUser(null, ME), false);
  assert.equal(blocksMentionUser('a string', ME), false);
});

test('blocksMentionUser: the walk stops at depth 8 (untrusted payload guard)', () => {
  const nest = (depth: number): unknown => {
    let node: unknown = { type: 'user', user_id: ME };
    for (let i = 0; i < depth; i++) node = { child: node };
    return node;
  };
  assert.equal(blocksMentionUser(nest(7), ME), true);
  assert.equal(blocksMentionUser(nest(20), ME), false, 'too deep to find — dropped, not crashed');
});

// ---------------------------------------------------------------------------
// keep / drop
// ---------------------------------------------------------------------------

test('a DM is kept and keyed on the CONVERSATION, not the message', async () => {
  const rt = runtime();
  const stored = await ingestMessage(rt, {
    ts: '1000.000100',
    channel: 'D1',
    channel_type: 'im',
    user: 'U_OTHER',
    text: 'ping',
  });
  assert.equal(stored, true);

  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.kind, 'dm');
  assert.equal(t.thread_ts, 'D1', 'thread_ts is the channel id for DMs');
  assert.equal(t.status, 'new');
  assert.equal(t.workspace, 'A');
  assert.equal(t.team_name, 'Acme');
});

test('a group DM (mpim) is keyed the same way', async () => {
  const rt = runtime();
  await ingestMessage(rt, { ts: '1000.000100', channel: 'G1', channel_type: 'mpim', user: 'U_OTHER', text: 'x' });
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.kind, 'dm');
  assert.equal(t.thread_ts, 'G1');
});

test('a back-and-forth DM accumulates into ONE card, threaded replies included', async () => {
  const rt = runtime();
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'one' });
  await ingestMessage(rt, { ts: '1000.000200', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'two' });
  await ingestMessage(rt, {
    ts: '1000.000300',
    thread_ts: '1000.000100', // a threaded reply inside the DM
    channel: 'D1',
    channel_type: 'im',
    user: 'U_OTHER',
    text: 'three',
  });
  assert.equal(countRows('threads'), 1);
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  assert.equal(messageRows(id).length, 3);
  assert.equal(threadRow(id)?.last_activity, '1000.000300');
});

test('a channel message that mentions me is kept as a mention thread', async () => {
  const rt = runtime();
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000100',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U_OTHER',
      text: `<@${ME}> can you look?`,
    }),
    true,
  );
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.kind, 'mention');
  assert.equal(t.thread_ts, '1000.000100', 'a top-level mention is keyed on its own ts');
});

test('a mention inside a thread is keyed on the parent thread_ts', async () => {
  const rt = runtime();
  await ingestMessage(rt, {
    ts: '1000.000900',
    thread_ts: '1000.000100',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U_OTHER',
    text: `<@${ME}>?`,
  });
  assert.equal((raw().prepare('SELECT thread_ts FROM threads').get() as { thread_ts: string }).thread_ts, '1000.000100');
});

test('an empty thread_ts falls back to the message ts', async () => {
  const rt = runtime();
  await ingestMessage(rt, {
    ts: '1000.000900',
    thread_ts: '',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U_OTHER',
    text: `<@${ME}>?`,
  });
  assert.equal((raw().prepare('SELECT thread_ts FROM threads').get() as { thread_ts: string }).thread_ts, '1000.000900');
});

test('the legacy <@U|name> form and a blocks-only mention are both kept', async () => {
  const rt = runtime();
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000100',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U_OTHER',
      text: `<@${ME}|isha> hi`,
    }),
    true,
  );
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000200',
      channel: 'C2',
      channel_type: 'channel',
      user: 'U_OTHER',
      text: 'hi there',
      blocks: [{ type: 'rich_text', elements: [{ elements: [{ type: 'user', user_id: ME }] }] }],
    }),
    true,
  );
  assert.equal(countRows('threads'), 2);
});

test('a channel message with no mention and no tracked thread is dropped, storing nothing', async () => {
  const rt = runtime();
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000100',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U_OTHER',
      text: 'unrelated chatter',
    }),
    false,
  );
  assert.equal(countRows('threads'), 0);
  assert.equal(countRows('messages'), 0);
  assert.deepEqual(rt.client.calls, [], 'no Slack lookups for a message we drop');
});

test('a reply in a thread we already track is kept even without a mention', async () => {
  const rt = runtime();
  const id = seedThread({ workspace: 'A', channel_id: 'C1', thread_ts: '1000.000100', kind: 'mention' });
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000500',
      thread_ts: '1000.000100',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U_OTHER',
      text: 'no mention here',
    }),
    true,
  );
  assert.equal(messageRows(id).length, 1);
  assert.equal(countRows('threads'), 1);
});

// ---------------------------------------------------------------------------
// my own messages
// ---------------------------------------------------------------------------

test('my own message never creates a thread — not even in a DM', async () => {
  const rt = runtime();
  assert.equal(
    await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: ME, text: 'me first' }),
    false,
  );
  assert.equal(
    await ingestMessage(rt, {
      ts: '1000.000200',
      channel: 'C1',
      channel_type: 'channel',
      user: ME,
      text: `<@${ME}> talking to myself`,
    }),
    false,
  );
  assert.equal(countRows('threads'), 0);
});

test('my own message in a tracked thread is stored but never marks it unread', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'D1', thread_ts: 'D1', kind: 'dm', status: 'done', last_activity: '1000.000100' });
  assert.equal(
    await ingestMessage(rt, { ts: '1000.000900', channel: 'D1', channel_type: 'im', user: ME, text: 'answered' }),
    true,
  );
  assert.equal(messageRows(id).length, 1);
  assert.equal(threadRow(id)?.status, 'done', 'my reply must not re-open a finished thread');
  assert.equal(threadRow(id)?.last_activity, '1000.000900', 'but it does move the thread up the feed');
});

// ---------------------------------------------------------------------------
// subtype allowlist
// ---------------------------------------------------------------------------

test('subtypes: undefined, file_share and thread_broadcast are allowed', async () => {
  const rt = runtime();
  let n = 0;
  for (const subtype of [undefined, 'file_share', 'thread_broadcast']) {
    n += 1;
    assert.equal(
      await ingestMessage(rt, {
        ts: `1000.00010${n}`,
        channel: `D${n}`,
        channel_type: 'im',
        user: 'U_OTHER',
        text: 'x',
        subtype,
      }),
      true,
      `subtype ${String(subtype)}`,
    );
  }
  assert.equal(countRows('threads'), 3);
});

test('subtypes: everything else is dropped before any other rule', async () => {
  const rt = runtime();
  for (const subtype of [
    'channel_join',
    'channel_leave',
    'bot_message',
    'message_changed',
    'message_deleted',
    'channel_topic',
    'tombstone',
    'me_message',
    '',
  ]) {
    assert.equal(
      await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'x', subtype }),
      false,
      `subtype ${subtype}`,
    );
  }
  assert.equal(countRows('threads'), 0);
});

test('a malformed event (missing or non-string ts / channel) is dropped', async () => {
  const rt = runtime();
  for (const ev of [
    { channel: 'D1', channel_type: 'im' },
    { ts: '1000.000100', channel_type: 'im' },
    { ts: 1000.0001, channel: 'D1', channel_type: 'im' },
    { ts: '1000.000100', channel: 123, channel_type: 'im' },
    {},
    null,
    undefined,
  ]) {
    assert.equal(await ingestMessage(rt, ev), false, JSON.stringify(ev));
  }
  assert.equal(countRows('threads'), 0);
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

test('a redelivered message is stored once and never re-opens the thread', async () => {
  const rt = runtime();
  const ev = { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'ping' };
  assert.equal(await ingestMessage(rt, ev), true);

  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  db.setThreadStatus(id, 'done'); // the user deals with it

  assert.equal(await ingestMessage(rt, ev), false, 'the duplicate reports "nothing stored"');
  assert.equal(messageRows(id).length, 1);
  assert.equal(threadRow(id)?.status, 'done', 'a redelivery must not resurrect it');
});

// ---------------------------------------------------------------------------
// WATCH-START RULE: history lands read, live traffic lands unread
// ---------------------------------------------------------------------------

test('historical: a swept message from before we started watching lands "seen"', async () => {
  const rt = runtime();
  assert.equal(
    await ingestMessage(
      rt,
      { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'old news' },
      { historical: true },
    ),
    true,
  );
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.status, 'seen', 'stored in full, but not claimed to need attention');
  assert.equal(t.last_activity, '1000.000100');
  assert.equal(countRows('messages'), 1);
});

test('live: the same message with no historical flag lands "new"', async () => {
  const rt = runtime();
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'fresh' });
  assert.equal((raw().prepare('SELECT status FROM threads').get() as { status: string }).status, 'new');
});

test('historical: an existing unread thread is never dragged back to "seen"', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'D1', thread_ts: 'D1', kind: 'dm', status: 'new', last_activity: '1000.000100' });
  await ingestMessage(
    rt,
    { ts: '1000.000050', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'older' },
    { historical: true },
  );
  assert.equal(threadRow(id)?.status, 'new');
  assert.equal(threadRow(id)?.last_activity, '1000.000100', 'and last_activity never moves backwards');
});

test('historical: a live message afterwards still marks the conversation unread', async () => {
  const rt = runtime();
  await ingestMessage(
    rt,
    { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'old' },
    { historical: true },
  );
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  assert.equal(threadRow(id)?.status, 'seen');
  await ingestMessage(rt, { ts: '2000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'new' });
  assert.equal(threadRow(id)?.status, 'new');
});

// ---------------------------------------------------------------------------
// channel name / permalink resolution
// ---------------------------------------------------------------------------

test('a new thread resolves its channel name and permalink once', async () => {
  const rt = runtime(fakeClient({ channelName: 'dream-team', permalink: 'https://slack.example/x' }));
  await ingestMessage(rt, {
    ts: '1000.000100',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U_OTHER',
    text: `<@${ME}> hi`,
  });
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.channel_name, 'dream-team');
  assert.equal(t.permalink, 'https://slack.example/x');
  assert.deepEqual(rt.client.calls, [
    'conversations.info:C1',
    'chat.getPermalink:C1/1000.000100',
    'users.info:U_OTHER',
  ]);
});

test('Slack being unreachable is not fatal — the thread is created without metadata', async () => {
  const rt = runtime(fakeClient({ channelName: null, permalink: null, userName: null }));
  assert.equal(
    await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'x' }),
    true,
  );
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.channel_name, null);
  assert.equal(t.permalink, null);
  assert.equal(messageRows(Number(t.id))[0].author_name, null);
});

test('missing metadata is filled in by a later message once Slack answers again', async () => {
  const client = fakeClient({ channelName: null, permalink: null });
  const rt = runtime(client);
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'one' });
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  assert.equal(threadRow(id)?.channel_name, null);

  // Slack comes back.
  client.channelName = 'Ruby Valderrama';
  client.permalink = 'https://slack.example/p2';
  await ingestMessage(rt, { ts: '1000.000200', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'two' });
  assert.equal(threadRow(id)?.channel_name, 'Ruby Valderrama');
  assert.equal(threadRow(id)?.permalink, 'https://slack.example/p2');

  // A third message must not re-ask for anything: the row is complete, and the author's
  // name was cached on first success.
  client.calls.length = 0;
  await ingestMessage(rt, { ts: '1000.000300', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'three' });
  assert.deepEqual(client.calls, []);
});

test('the metadata retry is rate-limited to once per thread per 10 minutes', async () => {
  const client = fakeClient({ channelName: null, permalink: null });
  const rt = runtime(client);
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'one' });

  client.calls.length = 0;
  await ingestMessage(rt, { ts: '1000.000200', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'two' });
  assert.deepEqual(client.calls, ['conversations.info:D1', 'chat.getPermalink:D1/1000.000200']);

  client.calls.length = 0;
  await ingestMessage(rt, { ts: '1000.000300', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'three' });
  assert.deepEqual(client.calls, [], 'the second retry is inside the 10-minute window');

  // Pretend 11 minutes went by.
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  rt.metadataRetryAt.set(id, Date.now() - 11 * 60_000);
  await ingestMessage(rt, { ts: '1000.000400', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'four' });
  assert.deepEqual(client.calls, ['conversations.info:D1', 'chat.getPermalink:D1/1000.000400']);
});

test('user names are cached on success only', async () => {
  const client = fakeClient({ userName: null });
  const rt = runtime(client);
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'one' });
  client.userName = 'Alice';
  await ingestMessage(rt, { ts: '1000.000200', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'two' });
  await ingestMessage(rt, { ts: '1000.000300', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'three' });

  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  assert.deepEqual(messageRows(id).map((m) => m.author_name), [null, 'Alice', 'Alice']);
  assert.equal(client.calls.filter((c) => c.startsWith('users.info')).length, 2, 'the success was cached');
});

test('the raw event payload is stored alongside the text', async () => {
  const rt = runtime();
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: 'x' });
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  const stored = JSON.parse(String(messageRows(id)[0].raw)) as { ts: string; text: string };
  assert.equal(stored.ts, '1000.000100');
  assert.equal(stored.text, 'x');
});

test('an empty message body is stored as NULL text', async () => {
  const rt = runtime();
  await ingestMessage(rt, { ts: '1000.000100', channel: 'D1', channel_type: 'im', user: 'U_OTHER', text: '' });
  const id = Number((raw().prepare('SELECT id FROM threads').get() as { id: number }).id);
  assert.equal(messageRows(id)[0].text, null);
});

// ---------------------------------------------------------------------------
// edits and deletions made in Slack
// ---------------------------------------------------------------------------

function analysed(threadId: number): void {
  db.upsertAnalysis({
    threadId,
    urgency: 'P1',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: '1000.000100',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'sess',
  });
}

test('message_changed rewrites the stored text and marks the analysis stale', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100', status: 'done', last_activity: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'before' });
  analysed(id);

  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    ts: '2000.000000', // the EVENT's ts, not the message's
    message: { ts: '1000.000100', text: 'after' },
    previous_message: { ts: '1000.000100', text: 'before' },
  });

  assert.equal(messageRows(id)[0].text, 'after');
  assert.equal(db.getAnalysisForThread(id)?.covered_through_ts, null, 're-queued for analysis');
  assert.equal(db.getAnalysisForThread(id)?.urgency, 'P1', 'the old verdict stays visible meanwhile');
  assert.equal(threadRow(id)?.status, 'done', 'a typo fix must not re-open a finished thread');
  assert.equal(threadRow(id)?.last_activity, '1000.000100');
});

test('a link-preview message_changed (text unchanged) is ignored entirely', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'look at https://example.com' });
  analysed(id);

  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    message: { ts: '1000.000100', text: 'look at https://example.com', attachments: [{ title: 'Example' }] },
    previous_message: { ts: '1000.000100', text: 'look at https://example.com' },
  });

  assert.equal(db.getAnalysisForThread(id)?.covered_through_ts, '1000.000100', 'no re-analysis');
});

test('message_deleted replaces the text with "(deleted)" and re-queues the thread', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100', status: 'seen' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'oops' });
  analysed(id);

  await handleMessageMutation(rt, {
    subtype: 'message_deleted',
    channel: 'C1',
    ts: '2000.000000',
    deleted_ts: '1000.000100',
  });

  assert.equal(messageRows(id)[0].text, '(deleted)');
  assert.match(String(messageRows(id)[0].deleted_at), /^\d{4}-/);
  assert.equal(db.getAnalysisForThread(id)?.covered_through_ts, null);
  assert.equal(threadRow(id)?.status, 'seen', 'status untouched');
});

test('message_deleted falls back to previous_message.ts when deleted_ts is absent', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'oops' });

  await handleMessageMutation(rt, {
    subtype: 'message_deleted',
    channel: 'C1',
    previous_message: { ts: '1000.000100', text: 'oops' },
  });
  assert.equal(messageRows(id)[0].text, '(deleted)');
});

test('a tombstone (delete of a parent that has replies) is treated as a deletion', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'the original question' });
  analysed(id);

  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    message: { ts: '1000.000100', subtype: 'tombstone', text: 'This message was deleted.' },
  });

  assert.equal(messageRows(id)[0].text, '(deleted)');
  assert.equal(db.getAnalysisForThread(id)?.covered_through_ts, null);
});

test('an edit or delete of a message we never stored is a silent no-op', async () => {
  const rt = runtime();
  await handleMessageMutation(rt, {
    subtype: 'message_deleted',
    channel: 'C1',
    deleted_ts: '1000.000100',
  });
  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    message: { ts: '1000.000100', text: 'still not mine' },
    previous_message: { ts: '1000.000100', text: 'was not mine' },
  });
  assert.equal(countRows('threads'), 0);
  assert.equal(countRows('messages'), 0);
});

test('an edit that ADDS an @me is re-offered to the filter and becomes news', async () => {
  const rt = runtime();
  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    channel_type: 'channel',
    message: { ts: '1000.000100', text: `oh and <@${ME}> should see this`, user: 'U_OTHER' },
    previous_message: { ts: '1000.000100', text: 'oh and someone should see this' },
  });

  assert.equal(countRows('threads'), 1, 'the edited message now qualifies as a mention');
  const t = raw().prepare('SELECT * FROM threads').get() as Record<string, unknown>;
  assert.equal(t.kind, 'mention');
  assert.equal(t.status, 'new');
  assert.equal(messageRows(Number(t.id))[0].text, `oh and <@${ME}> should see this`);
});

test('an edit that does NOT add a mention still creates nothing', async () => {
  const rt = runtime();
  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    channel_type: 'channel',
    message: { ts: '1000.000100', text: 'still nothing to do with me', user: 'U_OTHER' },
    previous_message: { ts: '1000.000100', text: 'nothing to do with me' },
  });
  assert.equal(countRows('threads'), 0);
});

test('a mutation event with a malformed payload is ignored', async () => {
  const rt = runtime();
  await handleMessageMutation(rt, { subtype: 'message_changed', channel: 123, message: { ts: '1', text: 'x' } });
  await handleMessageMutation(rt, { subtype: 'message_changed', channel: 'C1', message: null });
  await handleMessageMutation(rt, { subtype: 'message_changed', channel: 'C1', message: { text: 'no ts' } });
  await handleMessageMutation(rt, { subtype: 'message_deleted', channel: 'C1' });
  assert.equal(countRows('threads'), 0);
});

test('an edit that blanks a message stores NULL rather than an empty string', async () => {
  const rt = runtime();
  const id = seedThread({ channel_id: 'C1', thread_ts: '1000.000100' });
  seedMessage({ thread_id: id, ts: '1000.000100', text: 'something' });
  await handleMessageMutation(rt, {
    subtype: 'message_changed',
    channel: 'C1',
    message: { ts: '1000.000100', text: '' },
    previous_message: { ts: '1000.000100', text: 'something' },
  });
  assert.equal(messageRows(id)[0].text, null);
});
