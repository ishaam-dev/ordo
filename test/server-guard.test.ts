/**
 * CHARACTERIZATION — src/server.ts: the two security guarantees in front of every route.
 *
 *   1. Host allowlist  — DNS-rebinding defence. Only 127.0.0.1:<port> / localhost:<port>.
 *   2. Per-run token   — every /api/* request needs `x-copilot-token`.
 *
 * Runs on an ephemeral port against a temp database. Port 5252 (the user's live app) is
 * never touched. Raw `node:http` is used rather than fetch so the Host header can be
 * forged the way an attacker's page would.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { raw, resetDb, seedThread } from './helpers/fixtures.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);

/** Take an ephemeral port from the OS, then hand it to the server under test. */
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

// Capture the http.Server express creates, so this test process can shut it down and exit.
const servers: http.Server[] = [];
const realCreateServer = http.createServer;
(http as { createServer: typeof http.createServer }).createServer = ((
  ...args: Parameters<typeof http.createServer>
) => {
  const server = realCreateServer(...(args as Parameters<typeof http.createServer>));
  servers.push(server);
  return server;
}) as typeof http.createServer;

const { startServer } = await import('../src/server.js');

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
  contentType?: string;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${PORT}` };
    if (opts.token != null) headers['x-copilot-token'] = opts.token;
    if (opts.body !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json';
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
  // The token is minted per process and never persisted; the page reads it out of the
  // HTML the server injects it into, and so do we.
  const home = await request({ path: '/' });
  assert.equal(home.status, 200);
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

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

test('Host allowlist: 127.0.0.1:PORT and localhost:PORT are accepted', async () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
    const res = await request({ path: '/api/status', host, token: TOKEN });
    assert.equal(res.status, 200, host);
  }
});

test('Host allowlist: the comparison is case-insensitive', async () => {
  const res = await request({ path: '/api/status', host: `LOCALHOST:${PORT}`, token: TOKEN });
  assert.equal(res.status, 200);
});

test('Host allowlist: a forged Host is refused with 403 before any route runs', async () => {
  for (const host of [
    'evil.example.com',
    `evil.example.com:${PORT}`,
    'localhost', // no port
    '127.0.0.1', // no port
    `127.0.0.1:${PORT === 65535 ? 65534 : PORT + 1}`, // right host, wrong port
    `127.0.0.2:${PORT}`,
    `[::1]:${PORT}`,
    `attacker.com:${PORT}`,
  ]) {
    const res = await request({ path: '/api/status', host, token: TOKEN });
    assert.equal(res.status, 403, `Host: ${host}`);
    assert.match(res.body, /Forbidden: unexpected Host header/);
  }
});

test('Host allowlist: a forged Host cannot read the feed even with a valid token', async () => {
  seedThread({ last_activity: '1000.000100' });
  const forged = await request({ path: '/api/feed', host: 'evil.example.com', token: TOKEN });
  assert.equal(forged.status, 403);
  assert.doesNotMatch(forged.body, /channel_id|thread_ts|last_activity/);

  const ok = await request({ path: '/api/feed', token: TOKEN });
  assert.equal(ok.status, 200);
  assert.equal((JSON.parse(ok.body) as unknown[]).length, 1);
});

test('Host allowlist: it covers the UI and the static assets too, not just /api', async () => {
  for (const path of ['/', '/index.html', '/chat.js', '/chat.css']) {
    assert.equal((await request({ path, host: 'evil.example.com' })).status, 403, path);
    assert.equal((await request({ path })).status, 200, path);
  }
});

// ---------------------------------------------------------------------------
// per-run token
// ---------------------------------------------------------------------------

test('token: /api/* is 401 without a token and 200 with the right one', async () => {
  const without = await request({ path: '/api/status' });
  assert.equal(without.status, 401);
  assert.deepEqual(JSON.parse(without.body), { error: 'missing or invalid x-copilot-token' });

  const withToken = await request({ path: '/api/status', token: TOKEN });
  assert.equal(withToken.status, 200);
});

test('token: a wrong token is refused whatever its length', async () => {
  for (const token of [
    '',
    'nope',
    TOKEN.slice(0, -1), // one char short
    `${TOKEN}0`, // one char long
    TOKEN.slice(0, -1) + (TOKEN.endsWith('0') ? '1' : '0'), // same length, last char flipped
    TOKEN.toUpperCase(),
  ]) {
    const res = await request({ path: '/api/status', token });
    assert.equal(res.status, 401, `token=${JSON.stringify(token)}`);
  }
});

test('token: the UI itself is NOT behind the token (that is where the token comes from)', async () => {
  assert.equal((await request({ path: '/' })).status, 200);
  assert.equal((await request({ path: '/chat.js' })).status, 200);
});

test('token: the served HTML never contains the placeholder any more', async () => {
  const home = await request({ path: '/' });
  assert.doesNotMatch(home.body, /__COPILOT_TOKEN__/);
  assert.equal(home.headers['cache-control'], 'no-store');
  assert.match(String(home.headers['content-type']), /text\/html/);
});

test('the token is minted per run, so every /api route requires this exact value', async () => {
  for (const path of ['/api/status', '/api/feed', '/api/thread/1', '/api/thread/1/chat', '/api/emoji']) {
    assert.equal((await request({ path })).status, 401, path);
  }
  for (const path of [
    '/api/thread/1/status',
    '/api/thread/1/reanalyze',
    '/api/thread/1/reply',
    '/api/thread/1/message/1000.000100/react',
  ]) {
    assert.equal((await request({ path, method: 'POST', body: '{}' })).status, 401, path);
  }
});

test('an unauthenticated malformed body is 401, never a body-parser 400', async () => {
  // The body parser is mounted after the token check precisely so an unauthenticated
  // caller cannot tell a parse failure from an auth failure.
  const res = await request({ path: '/api/thread/1/status', method: 'POST', body: '{not json' });
  assert.equal(res.status, 401);

  const authed = await request({ path: '/api/thread/1/status', method: 'POST', token: TOKEN, body: '{not json' });
  assert.equal(authed.status, 400);
  assert.deepEqual(JSON.parse(authed.body), { error: 'invalid JSON' });
});

test('x-powered-by is disabled', async () => {
  const res = await request({ path: '/api/status', token: TOKEN });
  assert.equal(res.headers['x-powered-by'], undefined);
});

// ---------------------------------------------------------------------------
// route behaviour behind the guards
// ---------------------------------------------------------------------------

test('/api/status reports analyzer, server and workspace health', async () => {
  const res = await request({ path: '/api/status', token: TOKEN });
  const body = JSON.parse(res.body) as {
    analyzer: { state: string; queued: number };
    server: { startedAt: string; version: string | null };
    workspaces: unknown[];
  };
  assert.ok(['idle', 'analyzing', 'disabled', 'error'].includes(body.analyzer.state));
  assert.equal(typeof body.analyzer.queued, 'number');
  assert.match(body.server.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  // The reported version is package.json's — assert the shape, not a number that
  // every release bump would break.
  assert.match(String(body.server.version), /^\d+\.\d+\.\d+$/);
  assert.deepEqual(body.workspaces, [], 'no tokens are configured in a test process');
});

test('/api/thread/:id validates the id and 404s on an unknown thread', async () => {
  for (const id of ['0', '-1', 'abc', '1.5']) {
    const res = await request({ path: `/api/thread/${id}`, token: TOKEN });
    assert.equal(res.status, 400, id);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid thread id' });
  }
  const missing = await request({ path: '/api/thread/999999', token: TOKEN });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'thread not found' });
});

test('/api/thread/:id returns the thread with its messages and analysis', async () => {
  resetDb();
  const id = seedThread({ last_activity: '1000.000100' });
  const res = await request({ path: `/api/thread/${id}`, token: TOKEN });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { id: number; messages: unknown[]; analysis: unknown };
  assert.equal(body.id, id);
  assert.deepEqual(body.messages, []);
  assert.equal(body.analysis, null);
});

test('POST /api/thread/:id/status accepts only new|seen|done', async () => {
  resetDb();
  const id = seedThread();
  for (const status of ['new', 'seen', 'done']) {
    const res = await request({
      path: `/api/thread/${id}/status`,
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 200, status);
    assert.deepEqual(JSON.parse(res.body), { ok: true, id, status });
  }
  for (const body of ['{}', '{"status":"archived"}', '{"status":1}', '{"status":null}']) {
    const res = await request({ path: `/api/thread/${id}/status`, method: 'POST', token: TOKEN, body });
    assert.equal(res.status, 400, body);
    assert.deepEqual(JSON.parse(res.body), { error: "status must be one of 'new'|'seen'|'done'" });
  }
  const missing = await request({
    path: '/api/thread/999999/status',
    method: 'POST',
    token: TOKEN,
    body: '{"status":"done"}',
  });
  assert.equal(missing.status, 404);
});

test('POST /api/thread/:id/reanalyze enqueues; it never runs an analysis inline', async () => {
  resetDb();
  // Deliberately message-less: even if the scheduler picks this up, it fails long before
  // any AI harness is reached.
  const id = seedThread({ last_activity: '1000.000100' });
  const res = await request({ path: `/api/thread/${id}/reanalyze`, method: 'POST', token: TOKEN, body: '{}' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { ok: boolean; id: number; queued: number };
  assert.equal(body.ok, true);
  assert.equal(body.id, id);
  assert.equal(typeof body.queued, 'number');

  const missing = await request({ path: '/api/thread/999999/reanalyze', method: 'POST', token: TOKEN, body: '{}' });
  assert.equal(missing.status, 404);
});

test('GET /api/thread/:id/chat describes the destination without touching Slack', async () => {
  resetDb();
  const id = seedThread({ kind: 'dm', channel_id: 'D1', thread_ts: 'D1', channel_name: 'Ruby' });
  const res = await request({ path: `/api/thread/${id}/chat`, token: TOKEN });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as {
    destination: { label: string; thread_ts: string | null };
    messages: unknown[];
    seedable: boolean;
    busy: boolean;
  };
  assert.deepEqual(body.destination.label, 'Ruby');
  assert.equal(body.destination.thread_ts, null, 'a DM reply carries no thread_ts');
  assert.deepEqual(body.messages, []);
  assert.equal(body.seedable, false);
  assert.equal(body.busy, false);
});

test('POST /api/thread/:id/reply validates before it would ever reach Slack', async () => {
  resetDb();
  const id = seedThread();
  const cases: Array<[string, number, string]> = [
    ['{}', 400, 'text must be a string'],
    ['{"text":123}', 400, 'text must be a string'],
    ['{"text":"   "}', 400, 'text must not be empty'],
    [JSON.stringify({ text: 'x'.repeat(4_001) }), 413, 'text must be at most 4000 characters'],
  ];
  for (const [body, status, error] of cases) {
    const res = await request({ path: `/api/thread/${id}/reply`, method: 'POST', token: TOKEN, body });
    assert.equal(res.status, status, body.slice(0, 40));
    assert.equal((JSON.parse(res.body) as { error: string }).error, error);
  }

  // A valid body still cannot reach Slack: no workspace is configured in a test process,
  // so the send path refuses before any network call.
  const refused = await request({
    path: `/api/thread/${id}/reply`,
    method: 'POST',
    token: TOKEN,
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(refused.status, 503);
  assert.equal((JSON.parse(refused.body) as { error: string }).error, 'workspace_not_configured');
});

test('POST /api/thread/:id/message/:ts/react validates before it would ever reach Slack', async () => {
  resetDb();
  const id = seedThread();

  const badTs = await request({
    path: `/api/thread/${id}/message/notats/react`,
    method: 'POST',
    token: TOKEN,
    body: '{"name":"+1"}',
  });
  assert.equal(badTs.status, 400, 'a ts that is not a Slack ts is refused');

  for (const body of ['{}', '{"name":""}', '{"name":"Thumbs Up"}', '{"name":":+1:"}', JSON.stringify({ name: 'x'.repeat(101) })]) {
    const res = await request({
      path: `/api/thread/${id}/message/1000.000100/react`,
      method: 'POST',
      token: TOKEN,
      body,
    });
    assert.equal(res.status, 400, body.slice(0, 30));
    assert.equal((JSON.parse(res.body) as { error: string }).error, 'invalid reaction name');
  }

  const missing = await request({
    path: '/api/thread/999999/message/1000.000100/react',
    method: 'POST',
    token: TOKEN,
    body: '{"name":"+1"}',
  });
  assert.equal(missing.status, 404);

  // Email threads are read-only end to end; reacting is a Slack-only affordance.
  const mail = seedThread({ thread_ts: 'gmailthread1', channel_id: 'GMAIL' });
  raw().prepare("UPDATE threads SET source = 'gmail' WHERE id = ?").run(mail);
  const refusedMail = await request({
    path: `/api/thread/${mail}/message/1000.000100/react`,
    method: 'POST',
    token: TOKEN,
    body: '{"name":"+1"}',
  });
  assert.equal(refusedMail.status, 400);

  // A valid request still cannot reach Slack: no workspace is configured in a test
  // process, so the send path refuses before any network call — same shape as /reply.
  const refused = await request({
    path: `/api/thread/${id}/message/1000.000100/react`,
    method: 'POST',
    token: TOKEN,
    body: '{"name":"+1"}',
  });
  assert.equal(refused.status, 503);
});

test('GET /api/emoji answers an empty map when no workspace can be asked', async () => {
  const res = await request({ path: '/api/emoji', token: TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {});
});
