import express from 'express';
import crypto from 'node:crypto';
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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');
const indexHtmlPath = path.join(publicDir, 'index.html');

const VALID_STATUSES = new Set(['new', 'seen', 'done']);

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

  app.use(express.json());

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

  // index: false so a bare '/' can never fall through to the un-injected file on disk.
  app.use(express.static(publicDir, { index: false }));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`[server] listening on http://127.0.0.1:${port}`);
      console.log('[server] API requires a per-run token; open the UI in a browser to use it.');
      resolve();
    });
    server.on('error', reject);
  });
}
