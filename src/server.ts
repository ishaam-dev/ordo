import express from 'express';
import { spawn } from 'node:child_process';
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
  getItemById,
  getSlackUserNames,
  listItemsForThread,
  mentionedUserIds,
  setItemDone,
  setThreadStatus,
} from './db.js';
import { workspaceLabels } from './config.js';
import { requestReanalysis } from './analyzer.js';
import { chatSessionIdFor, registerChatRoutes } from './chat.js';
import { harnessReadiness, harnessStatus } from './harness/index.js';
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

/* ======================= Continue in Claude Code ========================== *
 *
 * Two Claude sessions exist per thread and they behave differently, so the UI offers
 * them as two separate, differently-labelled things:
 *
 *   analyses.session_id       the triage run. It was instructed to answer with a JSON
 *                             verdict, so it keeps doing that until told otherwise —
 *                             the UI warns about this rather than letting it surprise
 *                             someone into thinking Claude Code is broken.
 *   chat_sessions.session_id  the side-panel conversation (forked from the analysis
 *                             one). Ordinary prose, picks up mid-thought.
 *
 * Both exist on disk as resumable transcripts under
 * ~/.claude/projects/<slugged-cwd>/<id>.jsonl, and `claude --resume <id>` reopens one.
 *
 * ⚠ THIS IS THE ONLY PLACE IN THE APP THAT CAN CAUSE A COMMAND TO RUN. Everything
 * below is written as though the session id were hostile, because it very nearly is:
 * it reaches the database from an AI harness that was reading Slack messages written
 * by other people. The rules, in order:
 *
 *   1. A session id must match SESSION_ID_RE — a canonical UUID, nothing else — before
 *      it goes near a shell string, an AppleScript literal, or a rendered command.
 *      Checked at the route, again when the command is built, and again at the launcher,
 *      because each of those is separately reachable.
 *   2. The working directory is this process's own installation path. It is never taken
 *      from the request, and it is POSIX single-quoted before it enters a shell string.
 *   3. osascript is executed with an argument array (spawn, no shell), so the script
 *      text is one argv entry that no shell ever parses. The AppleScript literal itself
 *      is escaped, and control characters are refused outright.
 *   4. Nothing else is interpolated: not the token, not an env value, not message text,
 *      not the thread. Which terminal app to drive is a choice between two fixed
 *      scripts, not a string that gets pasted into one.
 */

/**
 * A resumable Claude session id, exactly: 8-4-4-4-12 hex.
 *
 * Deliberately stricter than "looks like a uuid" — no braces, no urn: prefix, no
 * surrounding whitespace, no trailing anything. If a stored id ever fails this, the
 * answer is to show no button, not to guess.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deliberately NOT a `value is string` type predicate: the interesting branch is the
// failing one, and a predicate narrows an already-string argument to `never` there —
// which would quietly delete the code that reports the refusal.
export function isResumableSessionId(value: unknown): boolean {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** How long osascript gets before we give up and let the UI offer the command instead. */
const TERMINAL_LAUNCH_TIMEOUT_MS = 20_000;

type TerminalApp = 'Terminal' | 'iTerm';

/**
 * POSIX single-quoting: the only bullet-proof way to put an arbitrary path into a
 * shell string. Inside single quotes the shell expands nothing at all; the one
 * character that has to be handled is the quote itself.
 */
function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The exact line the user could paste into a terminal themselves.
 *
 * The `cd` is not decoration: Claude Code files sessions under a slug of the working
 * directory, so `claude --resume <id>` from anywhere else simply will not find this
 * session. Same command whether we run it or the user does — one thing to get right,
 * and what the UI shows is what actually runs.
 */
export function resumeCommand(sessionId: string, cwd: string = projectRoot): string {
  if (!isResumableSessionId(sessionId)) {
    throw new Error('refusing to build a resume command for a non-UUID session id');
  }
  return `cd ${shellSingleQuote(cwd)} && claude --resume ${sessionId}`;
}

/**
 * Can THIS process open a terminal window?
 *
 * Only the Mac app grants it, and it grants it by handing the server an environment it
 * would never otherwise have (electron/main.js sets COPILOT_CAN_LAUNCH_TERMINAL before
 * it starts the server; electron/supervisor.js has always marked its child with
 * --copilot-managed). A server started from a shell, or one the Mac app merely attached
 * to, answers false — and the UI shows a copyable command instead of a dead button.
 */
export function terminalLaunchAllowed(): boolean {
  if (process.platform !== 'darwin') return false;
  return (
    process.env.COPILOT_CAN_LAUNCH_TERMINAL === '1' || process.argv.includes('--copilot-managed')
  );
}

/**
 * Which terminal to drive. The Mac app looks for iTerm and tells us; anything we do not
 * recognise means Terminal.app, which every Mac has.
 *
 * This value selects between two fixed scripts. It is never interpolated into one — an
 * env var reaching an AppleScript string would undo the whole point of the UUID gate.
 */
function preferredTerminal(): TerminalApp {
  return process.env.COPILOT_TERMINAL_APP === 'iTerm' ? 'iTerm' : 'Terminal';
}

/** Escape for an AppleScript string literal; control characters are refused, not escaped. */
function appleScriptString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('refusing to put a control character into an AppleScript string');
  }
  return `"${value.split('\\').join('\\\\').split('"').join('\\"')}"`;
}

/**
 * The whole script, with the command as its only variable part. Both branches are
 * literals in this file; `app` picks one, it does not contribute any text.
 */
function terminalScript(app: TerminalApp, command: string): string {
  const literal = appleScriptString(command);
  if (app === 'iTerm') {
    return [
      'tell application "iTerm"',
      '  activate',
      '  set _w to (create window with default profile)',
      `  tell current session of _w to write text ${literal}`,
      'end tell',
    ].join('\n');
  }
  return ['tell application "Terminal"', '  activate', `  do script ${literal}`, 'end tell'].join(
    '\n',
  );
}

/** osascript with an argv array — there is no shell in this call at any point. */
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the terminal did not answer in time'));
    }, TERMINAL_LAUNCH_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
      reject(new Error(tail !== '' ? tail : `osascript exited with code ${code}`));
    });
  });
}

/** Whatever went wrong, said in words the user can act on. */
function terminalFailureMessage(detail: string): string {
  if (/-1743|not authori[sz]ed|assistive access/i.test(detail)) {
    return 'This Mac has not given Slack Copilot permission to open Terminal. Copy the command below and run it yourself, or allow it in System Settings → Privacy & Security → Automation.';
  }
  if (/-600|isn.t running|not running/i.test(detail)) {
    return 'The terminal app would not start. Copy the command below and run it yourself.';
  }
  return 'Slack Copilot could not open a terminal window. Copy the command below and run it yourself.';
}

export interface TerminalLaunchResult {
  ok: boolean;
  terminal: TerminalApp;
  /** Plain-English, only when ok is false. */
  message?: string;
}

/**
 * Open a terminal sitting in the project directory with the resume command already
 * running. iTerm is tried first when the Mac app said the user has it, and Terminal.app
 * is the fallback — a terminal the user does not have is a failed launch, not a dead end.
 *
 * Throws (rather than returning ok:false) for a bad session id: that is a programming or
 * data-integrity fault, not something the user did, and it must never be quietly retried.
 */
export async function launchResumeInTerminal(sessionId: string): Promise<TerminalLaunchResult> {
  if (!isResumableSessionId(sessionId)) {
    throw new Error('refusing to launch a terminal for a non-UUID session id');
  }
  const command = resumeCommand(sessionId); // re-validates; fixed, quoted cwd
  const first = preferredTerminal();
  const order: TerminalApp[] = first === 'iTerm' ? ['iTerm', 'Terminal'] : ['Terminal'];

  let lastDetail = '';
  for (const app of order) {
    try {
      await runOsascript(terminalScript(app, command));
      console.log(`[server] handoff: opened ${app} on session ${sessionId.slice(0, 8)}…`);
      return { ok: true, terminal: app };
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      console.warn(`[server] handoff: ${app} would not open (${lastDetail.slice(0, 160)})`);
    }
  }
  return { ok: false, terminal: first, message: terminalFailureMessage(lastDetail) };
}

interface HandoffTarget {
  sessionId: string;
  command: string;
}

/**
 * One session slot for the UI. A stored id that is not a session id is dropped with a
 * warning rather than rendered: the button simply does not appear.
 *
 * Only the length is logged — a corrupt value could contain anything, including Slack
 * text, and this log is shown to the user and attached to bug reports.
 */
function handoffTarget(sessionId: string | null, label: string, threadId: number): HandoffTarget | null {
  if (sessionId === null || sessionId === '') return null;
  if (!isResumableSessionId(sessionId)) {
    console.warn(
      `[server] handoff: thread #${threadId} has a ${label} session id that is not a session id ` +
        `(${sessionId.length} chars) — refusing to offer it`,
    );
    return null;
  }
  return { sessionId, command: resumeCommand(sessionId) };
}

export function startServer(port: number): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  const allowedHosts = allowedHostsFor(port);

  // Host allowlist — mounted first so it covers every route, including static files.
  //
  // Chat streams over SSE (fetch + ReadableStream), not a WebSocket, precisely so it stays
  // behind this middleware and the token check. If a WebSocket is ever added it escapes both:
  // WS upgrades bypass CORS entirely and the handshake cannot carry a custom header. Such an
  // endpoint would have to (a) re-check Host on the upgrade against this same allowlist,
  // (b) validate `Origin` against it too, and (c) require the token via query param or first
  // frame. Prefer SSE and avoid the problem.
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
      // Which AI harness is running, whether it is usable, and what it cannot do. The
      // reading is cached; a stale one is refreshed in the background so this route
      // never waits on a subprocess.
      void harnessReadiness().catch(() => undefined);
      res.json({
        analyzer: analyzerHealth(),
        harness: harnessStatus(),
        server: { startedAt: STARTED_AT, version: APP_VERSION, now: new Date().toISOString() },
        workspaces: listWorkspaceHealth(),
        // Cosmetic per-slot display names from .env (SLACK_A_LABEL=…) — the UI shows
        // these instead of the bare A/B letters wherever a workspace is named.
        labels: workspaceLabels,
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
      const messages = getMessagesForThread(id);
      // Names for everyone mentioned inline anywhere in the thread, so the client can
      // render "@Ruby Chen" instead of "@U01U78WKD1S". Authors ride along on each
      // message row already; this map covers the people who were only talked about.
      const mentioned = new Set<string>();
      for (const m of messages) for (const uid of mentionedUserIds(m.text)) mentioned.add(uid);
      res.json({
        ...thread,
        messages,
        names: getSlackUserNames(thread.workspace, mentioned),
        analysis: getAnalysisForThread(id) ?? null,
        items: listItemsForThread(id),
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
  /**
   * The user's own checkbox on one item. Done pins it done (the analyzer may not
   * reopen it); unticking reopens it. Never a model-reachable path.
   */
  app.post('/api/thread/:id/item/:itemId', (req, res) => {
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const body = (req.body ?? {}) as { done?: unknown };
    if (typeof body.done !== 'boolean') {
      res.status(400).json({ error: 'done must be a boolean' });
      return;
    }
    try {
      const item = getItemById(itemId);
      if (!item || item.thread_id !== id) {
        res.status(404).json({ error: 'item not found' });
        return;
      }
      setItemDone(itemId, body.done);
      res.json({ ok: true, items: listItemsForThread(id) });
    } catch (err) {
      console.error('[server] item toggle failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

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

  /**
   * What "Continue in Claude Code" can offer for this thread.
   *
   * Two independent slots, because they are two different conversations with two
   * different personalities — see the block comment above. Either can be null: null
   * means "no button", never "guess something".
   *
   * `canLaunch` tells the page which affordance to draw. False (a browser, or a server
   * started from a shell) is not an error: the page shows the same command with a Copy
   * button, which is exactly what a POST would have run.
   */
  app.get('/api/thread/:id/handoff', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    try {
      if (!getThreadById(id)) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json({
        chat: handoffTarget(chatSessionIdFor(id), 'chat', id),
        analysis: handoffTarget(getAnalysisForThread(id)?.session_id ?? null, 'analysis', id),
        canLaunch: terminalLaunchAllowed(),
      });
    } catch (err) {
      console.error('[server] /api/thread/:id/handoff failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  /**
   * Open a terminal on one of those sessions. The request chooses WHICH session, never
   * what runs: the session id comes from our database and is re-validated here, the
   * working directory is this process's own, and the command is rebuilt from scratch.
   * There is no path by which request bytes reach the shell.
   *
   * Every refusal carries the command when there is one, so the page can fall back to
   * "here it is, copy it" instead of a button that appears to do nothing.
   */
  app.post('/api/thread/:id/handoff', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    const target = (req.body as { target?: unknown } | undefined)?.target;
    if (target !== 'chat' && target !== 'analysis') {
      res.status(400).json({ error: "target must be 'chat' or 'analysis'" });
      return;
    }
    try {
      if (!getThreadById(id)) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      const stored =
        target === 'chat' ? chatSessionIdFor(id) : (getAnalysisForThread(id)?.session_id ?? null);
      if (stored === null || stored === '') {
        res.status(404).json({
          error: 'no_session',
          message:
            target === 'chat'
              ? 'There is no chat session for this message yet — send Claude a message first.'
              : 'This message has not been rated yet, so there is nothing to look back at.',
        });
        return;
      }
      // The loud refusal. A stored id that is not a session id is a data-integrity
      // problem, and the one thing we must never do with it is run it.
      if (!isResumableSessionId(stored)) {
        console.error(
          `[server] handoff REFUSED: thread #${id} ${target} session id is not a session id ` +
            `(${stored.length} chars) — nothing was launched`,
        );
        res.status(400).json({
          error: 'invalid_session_id',
          message: 'That saved Claude session looks corrupted, so it will not be opened.',
        });
        return;
      }

      const command = resumeCommand(stored);
      if (!terminalLaunchAllowed()) {
        res.status(503).json({
          error: 'cannot_launch',
          message: 'Slack Copilot can only open Terminal from the Mac app.',
          command,
        });
        return;
      }

      void (async () => {
        try {
          const outcome = await launchResumeInTerminal(stored);
          if (!outcome.ok) {
            res.status(502).json({
              error: 'launch_failed',
              message: outcome.message,
              command,
            });
            return;
          }
          res.json({ ok: true, target, sessionId: stored, command, terminal: outcome.terminal });
        } catch (err) {
          console.error('[server] handoff launch failed:', err);
          res.status(500).json({ error: 'internal error', command });
        }
      })();
    } catch (err) {
      console.error('[server] /api/thread/:id/handoff (POST) failed:', err);
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
