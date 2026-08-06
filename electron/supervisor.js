'use strict';
/**
 * Keeps the Slack Copilot server alive and reports, in plain English, whether it is.
 *
 * Two modes, decided at runtime:
 *   - "ours"     — nothing was listening, so we started the server ourselves and we
 *                  restart it if it dies and stop it when the app quits.
 *   - "external" — a server was already listening (e.g. a developer running
 *                  `npm run dev`). We attach to it read-only and never kill it.
 *
 * That distinction is what stops the packaged app from fighting a dev server for
 * the port, and stops it from taking a dev server down when the user quits.
 */
const { EventEmitter } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  baseUrl,
  config,
  findNode,
  log,
  logFile,
  readJson,
  rotateIfBig,
  serverPath,
  userDataFile,
  writeJson,
} = require('./env');

/** Marker on the child's command line so we can recognise our own process later. */
const MANAGED_FLAG = '--copilot-managed';

const PROBE_MS = 3000;
const BOOT_GRACE_MS = 60_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000, 60_000];
const HEALTHY_RESET_MS = 60_000;
/**
 * How long a server we attached to may be missing before we take over from it.
 * A developer's `tsx watch` rebinds the port within a second or two on every file
 * save; grabbing it in that window would break their setup, so we wait it out.
 */
const EXTERNAL_TAKEOVER_GRACE_MS = 30_000;
/** Slack rotates socket connections routinely; only call it a problem if it sticks. */
const SLACK_TROUBLE_GRACE_MS = 60_000;

class Supervisor extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.adoptedPid = null;
    this.owner = null; // 'ours' | 'external' | null
    this.externalGoneSince = null;
    this.serverState = 'starting'; // starting | up | down | conflict | misconfigured
    this.slackState = 'unknown'; // unknown | connected | reconnecting | error | not-configured
    this.slackTeams = [];
    this.slackTroubleSince = null;
    this.problem = null; // extra plain-English detail
    this.restarts = 0;
    this.attempt = 0;
    this.spawnedAt = 0;
    this.lastHealthyAt = 0;
    this.nextSpawnAt = 0;
    this.paused = false;
    this.timer = null;
    this.stopping = false;
  }

  /* --------------------------------------------------------------- status -- */

  status() {
    return {
      server: this.serverState,
      owner: this.owner,
      slack: this.slackState,
      slackTeams: this.slackTeams.slice(),
      problem: this.problem,
      restarts: this.restarts,
    };
  }

  emitStatus() {
    const key = JSON.stringify(this.status());
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit('status', this.status());
  }

  setServerState(state, problem = null) {
    if (this.serverState !== state || this.problem !== problem) {
      if (this.serverState !== state) log(`server state: ${this.serverState} -> ${state}`);
      this.serverState = state;
      this.problem = problem;
    }
    this.emitStatus();
  }

  /* ------------------------------------------------------------ lifecycle -- */

  start() {
    this.stopping = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), PROBE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.nextSpawnAt = 0; // after a wake, retry immediately rather than waiting out a backoff
    this.tick();
  }

  /** Called on quit. Only ever stops a server we started — never an external one. */
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.owner === 'external') {
      log('quitting; leaving the already-running server alone');
      return;
    }
    const pid = this.child ? this.child.pid : this.adoptedPid;
    if (!pid) return;
    log(`stopping our server (pid ${pid})`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    // Give it a moment to close the database cleanly, then insist.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await delay(100);
      try {
        process.kill(pid, 0);
      } catch {
        log('server stopped cleanly');
        return;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
      log('server did not stop in time; forced it');
    } catch {
      /* already gone */
    }
  }

  /** Menu action: bounce the server we manage (no-op for an external one). */
  restart() {
    if (this.owner === 'external') return false;
    const pid = this.child ? this.child.pid : this.adoptedPid;
    if (pid) {
      log('restarting server on request');
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    this.adoptedPid = null;
    this.attempt = 0;
    this.nextSpawnAt = 0;
    this.setServerState('starting');
    this.tick();
    return true;
  }

  /* ----------------------------------------------------------------- loop -- */

  async tick() {
    if (this.paused || this.stopping) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      const probe = await probeServer();

      if (probe === 'up') {
        this.onServerUp();
      } else if (probe === 'foreign') {
        this.owner = null;
        this.setServerState(
          'conflict',
          'Another program on this Mac is using the connection Slack Copilot needs.',
        );
      } else {
        this.onServerDown();
      }
    } catch (err) {
      log('health check failed:', String(err && err.message));
    } finally {
      this.ticking = false;
    }
  }

  onServerUp() {
    if (!this.owner) {
      // Someone is listening and we did not start them this session. It may be an
      // orphan of ours from a previous run (recognisable by its command line), or a
      // developer's `npm run dev` — which we must leave completely alone.
      const orphan = findOrphanPid();
      if (orphan) {
        log(`adopting our own leftover server (pid ${orphan})`);
        this.adoptedPid = orphan;
        this.owner = 'ours';
      } else {
        log('a Slack Copilot server is already running; attaching to it');
        this.owner = 'external';
        this.slackState = 'unknown';
      }
    }
    this.lastHealthyAt = Date.now();
    this.externalGoneSince = null;
    if (Date.now() - this.spawnedAt > HEALTHY_RESET_MS) this.attempt = 0;
    this.setServerState('up');
  }

  onServerDown() {
    if (this.child && Date.now() - this.spawnedAt < BOOT_GRACE_MS) {
      this.setServerState('starting'); // still booting (tsx compiles on first run)
      return;
    }
    if (this.owner === 'external') {
      if (!this.externalGoneSince) this.externalGoneSince = Date.now();
      if (Date.now() - this.externalGoneSince < EXTERNAL_TAKEOVER_GRACE_MS) {
        this.setServerState('starting'); // almost certainly just restarting
        return;
      }
      log('the server we attached to has been gone a while; taking over');
      this.owner = null;
      this.externalGoneSince = null;
    }
    if (this.child) {
      log('server is not answering; restarting it');
      try {
        process.kill(this.child.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this.adoptedPid = null;
    this.maybeSpawn();
  }

  maybeSpawn() {
    if (this.child || this.stopping) return;
    if (Date.now() < this.nextSpawnAt) {
      this.setServerState('down', this.problemForDown());
      return;
    }

    const { projectDir } = config();
    if (!projectDir) {
      this.setServerState(
        'misconfigured',
        "Slack Copilot can't find its files. Open the Slack Copilot folder and double-click install.command again.",
      );
      return;
    }
    const nodeBin = findNode();
    if (!nodeBin) {
      this.setServerState(
        'misconfigured',
        'A piece of software Slack Copilot needs (Node) is missing from this Mac.',
      );
      return;
    }

    this.spawnServer(nodeBin, projectDir);
  }

  problemForDown() {
    if (this.restarts >= 5 && Date.now() - this.lastHealthyAt > 5 * 60_000) {
      return "Slack Copilot keeps stopping. Open the activity log to see why.";
    }
    return null;
  }

  spawnServer(nodeBin, projectDir) {
    const { port } = config();
    const entry = path.join(projectDir, 'src', 'index.ts');
    const env = { ...process.env, PATH: serverPath(), PORT: String(port) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;

    log(`starting server: node --import tsx src/index.ts (port ${port}, in ${projectDir})`);
    let child;
    try {
      child = spawn(nodeBin, ['--import', 'tsx', entry, MANAGED_FLAG], {
        cwd: projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log('could not start the server:', String(err && err.message));
      this.scheduleRetry();
      this.setServerState('down');
      return;
    }

    this.child = child;
    this.spawnedAt = Date.now();
    this.owner = 'ours';
    this.slackState = 'unknown';
    this.slackTeams = [];
    this.slackTroubleSince = null;
    this.setServerState('starting');
    writeJson(userDataFile('server.json'), { pid: child.pid, startedAt: this.spawnedAt, port });

    const onLine = (line) => this.readServerLine(line);
    pipeToLog(child.stdout, onLine);
    pipeToLog(child.stderr, onLine);

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.restarts += 1;
      log(`server exited (code ${code}, signal ${signal || 'none'})`);
      this.slackState = 'unknown';
      this.slackTeams = [];
      if (!this.stopping) {
        this.scheduleRetry();
        this.setServerState('down', this.problemForDown());
      }
    });
    child.on('error', (err) => {
      log('server process error:', String(err && err.message));
    });
  }

  scheduleRetry() {
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.nextSpawnAt = Date.now() + wait;
    log(`will try starting the server again in ${Math.round(wait / 1000)}s`);
  }

  /* -------------------------------------------------- reading the server --- */

  /**
   * The server's own log lines are the only window we have into whether Slack is
   * actually connected, so we watch them. Matching is deliberately loose: an
   * unrecognised line just leaves the state alone.
   */
  readServerLine(line) {
    const l = line.trim();
    if (!l) return;

    if (/no workspaces configured/i.test(l)) {
      this.slackState = 'not-configured';
      this.emitStatus();
      return;
    }
    const connected = l.match(/^\[([AB])\]\s+connected to "(.+?)" as user/i);
    if (connected) {
      const team = connected[2];
      if (!this.slackTeams.includes(team)) this.slackTeams.push(team);
      this.slackState = 'connected';
      this.slackTroubleSince = null;
      this.emitStatus();
      return;
    }
    if (/now connected to slack/i.test(l)) {
      this.slackState = 'connected';
      this.slackTroubleSince = null;
      this.emitStatus();
      return;
    }
    if (/failed to start ingest for workspace/i.test(l)) {
      this.slackState = 'error';
      this.emitStatus();
      return;
    }
    if (
      /(socket|websocket).*(disconnect|reconnect|error)/i.test(l) ||
      /unable to (connect|establish)/i.test(l) ||
      /server explicit disconnect/i.test(l)
    ) {
      if (!this.slackTroubleSince) this.slackTroubleSince = Date.now();
      if (Date.now() - this.slackTroubleSince > SLACK_TROUBLE_GRACE_MS) {
        this.slackState = 'reconnecting';
        this.emitStatus();
      }
      return;
    }
    // Any normal activity means the socket is alive again.
    if (this.slackTroubleSince && /^\[[AB]\]/.test(l)) {
      this.slackTroubleSince = null;
      if (this.slackState === 'reconnecting') {
        this.slackState = 'connected';
        this.emitStatus();
      }
    }
  }
}

/* ------------------------------------------------------------- helpers ----- */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeToLog(stream, onLine) {
  if (!stream) return;
  const file = logFile('server.log');
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    try {
      rotateIfBig(file);
      fs.appendFileSync(file, chunk, { mode: 0o600 });
    } catch {
      /* ignore */
    }
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on('error', () => {});
}

/**
 * Is anything answering on our port, and is it us?
 * Returns 'up' | 'foreign' | 'down'.
 */
async function probeServer() {
  let res;
  try {
    res = await fetch(baseUrl() + '/', {
      signal: AbortSignal.timeout(2500),
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
  } catch {
    return 'down';
  }
  if (!res.ok) return 'foreign';
  let html;
  try {
    html = await res.text();
  } catch {
    return 'foreign';
  }
  return /slack copilot/i.test(html) || /COPILOT_TOKEN/.test(html) ? 'up' : 'foreign';
}

/**
 * A server we started in a previous run that outlived us (app crash, force quit).
 * Recognised by the marker argument we always pass, so a developer's `npm run dev`
 * can never match.
 */
function findOrphanPid() {
  const saved = readJson(userDataFile('server.json'));
  const pid = saved && Number(saved.pid);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null; // not running
  }
  try {
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 4000,
    });
    return cmd.includes(MANAGED_FLAG) ? pid : null;
  } catch {
    return null;
  }
}

module.exports = { Supervisor, MANAGED_FLAG, probeServer };
