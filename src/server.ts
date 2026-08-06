import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFeed,
  getThreadById,
  getMessagesForThread,
  getAnalysisForThread,
  setThreadStatus,
} from './db.js';
import { requestReanalysis } from './analyzer.js';
import { registerChatRoutes } from './chat.js';
import { analyzerHealth, listWorkspaceHealth } from './health.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');
const indexHtmlPath = path.join(publicDir, 'index.html');

const VALID_STATUSES = new Set(['new', 'seen', 'done']);

/** Wall-clock start of this process — reported by /api/status so the UI can say "since". */
const STARTED_AT = new Date().toISOString();

/** Best-effort app version for /api/status; absent is fine, never fatal. */
const APP_VERSION: string | null = (() => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const v = (pkg as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
})();

/** Literal string in public/index.html that is swapped for the real token when we serve '/'. */
const TOKEN_PLACEHOLDER = '__COPILOT_TOKEN__';

/**
 * Per-run API token. Minted fresh on every process start, never persisted and never
 * logged — the only copy that leaves this process is the one injected into the HTML
 * we serve from '/'. This is the second layer of defence for the local API: the Host
 * allowlist below stops DNS-rebinding attacks, and this stops anything else that can
 * reach 127.0.0.1 but cannot read our HTML (the token is not a cookie, so it is never
 * attached automatically by the browser to cross-site requests).
 */
const API_TOKEN = crypto.randomBytes(32).toString('hex');
const API_TOKEN_BYTES = Buffer.from(API_TOKEN, 'utf8');

function tokenMatches(provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const given = Buffer.from(provided, 'utf8');
  if (given.length !== API_TOKEN_BYTES.length) return false;
  return crypto.timingSafeEqual(given, API_TOKEN_BYTES);
}

/**
 * DNS-rebinding defence: a malicious page can point its own hostname at 127.0.0.1, but
 * it cannot change the Host header the browser sends. Only the two names the user can
 * legitimately type for this server are accepted; everything else is refused before any
 * route (including static assets) runs.
 */
function allowedHostsFor(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

async function sendIndexHtml(res: express.Response): Promise<void> {
  try {
    const html = await readFile(indexHtmlPath, 'utf8');
    res
      .type('html')
      .set('Cache-Control', 'no-store')
      .send(html.split(TOKEN_PLACEHOLDER).join(API_TOKEN));
  } catch (err) {
    console.error('[server] failed to read public/index.html:', err);
    res.status(500).type('text/plain').send('failed to load UI\n');
  }
}

export function startServer(port: number): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  const allowedHosts = allowedHostsFor(port);

  // Host allowlist — mounted first so it covers every route, including static files.
  //
  // NOTE for the upcoming WebSocket/chat endpoint: WS upgrades bypass CORS entirely and
  // custom headers cannot be set on the handshake, so this middleware alone will not cover
  // them. That endpoint must (a) re-check the Host header on the upgrade request against
  // this same allowlist, (b) explicitly validate the `Origin` header against it too, and
  // (c) require the same x-copilot-token, passed as a query param or as the first frame.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      res.status(403).type('text/plain').send('Forbidden: unexpected Host header\n');
      return;
    }
    next();
  });

  // Token-injected UI. Registered before express.static so the raw placeholder file is
  // never served for '/' or '/index.html'.
  app.get('/', (_req, res) => {
    void sendIndexHtml(res);
  });
  app.get('/index.html', (_req, res) => {
    void sendIndexHtml(res);
  });

  // Every /api/* request must carry the per-run token.
  app.use('/api', (req, res, next) => {
    if (!tokenMatches(req.headers['x-copilot-token'])) {
      res.status(401).json({ error: 'missing or invalid x-copilot-token' });
      return;
    }
    next();
  });

  // Body parsing runs AFTER authentication and only under /api. Mounted globally and
  // first (as it was), a malformed body reached the parser's error path before the
  // token was ever checked, so an unauthenticated caller could tell a 400 from a 401.
  app.use('/api', express.json({ limit: '256kb' }));
  // (its parse failures are turned into JSON by the /api error handler at the bottom)

  /**
   * Health of the moving parts, in a shape the UI can render in plain English.
   * Everything here is read from the in-process registry (src/health.ts) — no polling,
   * no subprocess, no secrets. `workspaces[].registered:false` means ingest has not
   * reported yet, which is deliberately different from claiming a connection.
   */
  app.get('/api/status', (_req, res) => {
    try {
      res.json({
        analyzer: analyzerHealth(),
        server: { startedAt: STARTED_AT, version: APP_VERSION, now: new Date().toISOString() },
        workspaces: listWorkspaceHealth(),
      });
    } catch (err) {
      console.error('[server] /api/status failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/feed', (_req, res) => {
    try {
      res.json(getFeed());
    } catch (err) {
      console.error('[server] /api/feed failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/thread/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    try {
      const thread = getThreadById(id);
      if (!thread) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json({
        ...thread,
        messages: getMessagesForThread(id),
        analysis: getAnalysisForThread(id) ?? null,
      });
    } catch (err) {
      console.error('[server] /api/thread failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/api/thread/:id/status', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: "status must be one of 'new'|'seen'|'done'" });
      return;
    }
    try {
      const updated = setThreadStatus(id, status as 'new' | 'seen' | 'done');
      if (!updated) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json({ ok: true, id, status });
    } catch (err) {
      console.error('[server] status update failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  /**
   * Ask for one thread to be re-analyzed now: clears its failure backoff and puts it at
   * the front of the analyzer queue. It does NOT run the analysis inline — the analyzer
   * stays strictly one-at-a-time, so this only ever enqueues.
   */
  app.post('/api/thread/:id/reanalyze', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    try {
      const result = requestReanalysis(id);
      if (!result.ok) {
        if (result.reason === 'unknown_thread') {
          res.status(404).json({ error: 'thread not found' });
          return;
        }
        res.status(503).json({ error: 'analyzer is turned off' });
        return;
      }
      res.json({ ok: true, id, queued: result.queued });
    } catch (err) {
      console.error('[server] reanalyze failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  /*
   * Chat + the send path (src/chat.ts):
   *   GET  /api/thread/:id/chat    prior chat messages
   *   POST /api/thread/:id/chat    one chat turn, streamed back as SSE
   *   POST /api/thread/:id/reply   post {text} to Slack as the user
   *
   * Mounted here, under /api and after the two middlewares above, so they inherit the
   * Host allowlist and the per-run token exactly like every other route. Streaming is
   * SSE on this same authenticated request rather than a WebSocket — a WS handshake
   * cannot carry the token header and bypasses CORS entirely, so it would have needed
   * its own Origin/Host/token checks to be equally safe.
   *
   * Posting to Slack is deliberately NOT reachable by the model: it is a separate
   * endpoint whose body carries the text the user just saw, fired by a button click.
   */
  registerChatRoutes(app);

  // index: false so a bare '/' can never fall through to the un-injected file on disk.
  app.use(express.static(publicDir, { index: false }));

  /**
   * /api errors answer in JSON, never as Express's default HTML stack-trace page
   * (which is both unparseable by the UI and a detail leak). Registered last so it
   * catches body-parser failures and anything a route forwards. Four params — that is
   * what marks a middleware as an error handler in Express.
   */
  app.use(
    '/api',
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const e = err as { type?: string; status?: number } | null;
      if (e?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        res.status(400).json({ error: 'invalid JSON' });
        return;
      }
      if (e?.type === 'entity.too.large') {
        res.status(413).json({ error: 'request body too large' });
        return;
      }
      console.error('[server] unhandled /api error:', err);
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500;
      res.status(status).json({ error: 'internal error' });
    },
  );

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`[server] listening on http://127.0.0.1:${port}`);
      console.log('[server] API requires a per-run token; open the UI in a browser to use it.');
      resolve();
    });
    server.on('error', reject);
  });
}
