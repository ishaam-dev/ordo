'use strict';
/**
 * Where things live, and how to talk to the outside world.
 *
 * The packaged app is a thin shell around the project folder: it runs the same
 * code `npm run dev` runs, from the same directory, so it picks up .env and
 * data.db exactly the way the developer setup does. Nothing is copied into the
 * app bundle, so nothing can go stale.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');

const DEFAULT_PORT = 5252;

/** Node must be new enough for the server's built-in `node:sqlite`. */
const MIN_NODE_MAJOR = 22;

const NODE_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/opt/local/bin/node',
  '/usr/bin/node',
];

const PROJECT_GUESSES = [
  'slack-copilot',
  'Documents/slack-copilot',
  'Developer/slack-copilot',
  'Projects/slack-copilot',
  'code/slack-copilot',
  'src/slack-copilot',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch (err) {
    log('could not write', file, String(err && err.message));
    return false;
  }
}

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

/** A directory only counts as the project if it can actually run the server. */
function projectLooksUsable(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, 'src', 'index.ts')) &&
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'node_modules', 'tsx'))
    );
  } catch {
    return false;
  }
}

function guessProjectDir() {
  const home = os.homedir();
  for (const rel of PROJECT_GUESSES) {
    const dir = path.join(home, rel);
    if (projectLooksUsable(dir)) return dir;
  }
  return null;
}

let cachedConfig = null;

/**
 * Resolution order for the project folder:
 *   1. SLACK_COPILOT_PROJECT_DIR (for testing)
 *   2. the config the installer wrote into Application Support
 *   3. the path baked in at build time
 *   4. a short list of obvious places
 */
function config() {
  if (cachedConfig) return cachedConfig;
  const fromInstaller = readJson(userDataFile('config.json')) || {};
  const fromBuild = readJson(path.join(__dirname, 'project-path.json')) || {};

  const candidates = [
    process.env.SLACK_COPILOT_PROJECT_DIR,
    fromInstaller.projectDir,
    fromBuild.projectDir,
  ].filter(Boolean);

  let projectDir = candidates.find(projectLooksUsable) || null;
  if (!projectDir) projectDir = guessProjectDir();

  const rawPort = process.env.SLACK_COPILOT_PORT || fromInstaller.port || fromBuild.port;
  const port = Number(rawPort);

  cachedConfig = {
    projectDir,
    projectDirCandidates: candidates,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
  };
  return cachedConfig;
}

function baseUrl() {
  return `http://127.0.0.1:${config().port}`;
}

/* -------------------------------------------------------------- node ------ */

function nodeVersionMajor(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const m = out.match(/^v(\d+)\./);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

let cachedNode;

/** Newest usable Node on the machine. GUI apps get a bare PATH, so we look by hand. */
function findNode() {
  if (cachedNode !== undefined) return cachedNode;
  const seen = new Set();
  const found = [];
  for (const bin of NODE_CANDIDATES) {
    if (seen.has(bin) || !fs.existsSync(bin)) continue;
    seen.add(bin);
    const major = nodeVersionMajor(bin);
    if (major >= MIN_NODE_MAJOR) found.push({ bin, major });
  }
  if (found.length === 0) {
    // Nothing in the usual places: ask the user's login shell where node is.
    try {
      const out = execFileSync('/bin/zsh', ['-ilc', 'command -v node'], {
        encoding: 'utf8',
        timeout: 8000,
      }).trim().split('\n').filter(Boolean).pop();
      if (out && fs.existsSync(out)) {
        const major = nodeVersionMajor(out);
        if (major >= MIN_NODE_MAJOR) found.push({ bin: out, major });
      }
    } catch {
      /* ignore */
    }
  }
  found.sort((a, b) => b.major - a.major);
  cachedNode = found.length ? found[0].bin : null;
  log(cachedNode ? `using node at ${cachedNode}` : 'no usable node found');
  return cachedNode;
}

/* -------------------------------------------------------------- PATH ------ */

const FALLBACK_PATH = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

let cachedShellPath;

/**
 * When macOS launches an app from Finder or at login it gets a minimal PATH, so the
 * analyzer would not be able to find the `claude` CLI. Borrow the login shell's PATH
 * once and cache it; fall back to a sane list if that fails.
 */
function serverPath() {
  if (cachedShellPath) return cachedShellPath;
  const cacheFile = userDataFile('shell-path.json');
  const cached = readJson(cacheFile);
  let fromShell = cached && typeof cached.path === 'string' ? cached.path : null;

  if (!fromShell) {
    try {
      fromShell = execFileSync('/bin/zsh', ['-ilc', 'printf %s "$PATH"'], {
        encoding: 'utf8',
        timeout: 8000,
      }).trim();
      if (fromShell) writeJson(cacheFile, { path: fromShell, capturedAt: new Date().toISOString() });
    } catch {
      fromShell = null;
    }
  }

  const nodeBin = findNode();
  const parts = [];
  if (nodeBin) parts.push(path.dirname(nodeBin));
  if (fromShell) parts.push(...fromShell.split(':'));
  parts.push(...FALLBACK_PATH);

  const seen = new Set();
  cachedShellPath = parts.filter((p) => p && !seen.has(p) && seen.add(p)).join(':');
  return cachedShellPath;
}

/* ------------------------------------------------------------ logging ----- */

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function logDir() {
  const dir = app.getPath('logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

function logFile(name) {
  return path.join(logDir(), name);
}

function rotateIfBig(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
  } catch {
    /* file may not exist yet */
  }
}

/**
 * Appends to ~/Library/Logs/Slack Copilot/app.log. Callers must never pass the API
 * token or anything read out of .env — this file is plain text on disk.
 */
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const file = logFile('app.log');
    rotateIfBig(file);
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch {
    /* logging must never take the app down */
  }
}

module.exports = {
  DEFAULT_PORT,
  MIN_NODE_MAJOR,
  baseUrl,
  config,
  findNode,
  log,
  logDir,
  logFile,
  projectLooksUsable,
  readJson,
  rotateIfBig,
  serverPath,
  userDataFile,
  writeJson,
};
