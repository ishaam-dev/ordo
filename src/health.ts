/**
 * Health registry — the one place that knows whether this app is actually working.
 *
 * Why it exists: the analyzer runs in the background and its failures used to be
 * visible only as a `console.warn` in a terminal the user never looks at. A thread
 * would sit at "Analyzing…" forever with no explanation. Everything the UI needs to
 * say "here is what is broken and here is what to do about it" lives here, is served
 * by GET /api/status, and is rendered in plain English by public/index.html.
 *
 * Rules for this module:
 * - No I/O, no imports from analyzer/server (they import this, not the other way).
 * - Never store secrets. Tokens, .env values and Slack transcript text must never
 *   reach this registry: everything here is served over the API and rendered in a
 *   browser page.
 * - Every user-facing string here is written for a non-technical reader.
 */

import { workspaces } from './config.js';

// ---------------------------------------------------------------------------
// analyzer
// ---------------------------------------------------------------------------

export type AnalyzerState = 'idle' | 'analyzing' | 'disabled' | 'error';

/**
 * Failure buckets. `message`/`hint` are shown verbatim to a non-technical user, so
 * they must stay jargon-free (no "OAuth", "daemon", "SDK", "token", "stderr").
 */
export type AnalyzerErrorKind =
  | 'auth' // not signed in to Claude on this machine
  | 'timeout' // the run exceeded its wall-clock budget
  | 'rate_limit' // temporarily throttled; clears by itself
  | 'budget' // plan/usage/credit cap reached
  | 'bad_output' // Claude replied, but not with the JSON we require
  | 'unknown'; // anything we could not place

export interface AnalyzerFailure {
  kind: AnalyzerErrorKind;
  /** One plain sentence a fund accountant can act on. */
  message: string;
  /** What to do about it, in plain language. */
  hint: string;
  /** Exact command to run, when a command is the fix. `null` otherwise. */
  command: string | null;
  /** ISO timestamp of the failure. */
  at: string;
  /** Truncated technical text, for a tooltip / bug report. Never shown as the headline. */
  detail: string;
}

export interface AnalyzerHealth {
  state: AnalyzerState;
  /** Threads waiting for a first or refreshed analysis. */
  queued: number;
  /** ISO time of the last successful analysis, or null if none this run. */
  lastOk: string | null;
  /** Most recent failure; cleared by the next success. */
  lastError: AnalyzerFailure | null;
  /** Thread currently being analyzed, if any. */
  currentThreadId: number | null;
  /** Consecutive failures since the last success — a "1" is noise, a "5" is a real outage. */
  consecutiveFailures: number;
}

const analyzer: AnalyzerHealth = {
  state: 'idle',
  queued: 0,
  lastOk: null,
  lastError: null,
  currentThreadId: null,
  consecutiveFailures: 0,
};

/** Read-only snapshot for the API. */
export function analyzerHealth(): AnalyzerHealth {
  return {
    state: analyzer.state,
    queued: analyzer.queued,
    lastOk: analyzer.lastOk,
    lastError: analyzer.lastError === null ? null : { ...analyzer.lastError },
    currentThreadId: analyzer.currentThreadId,
    consecutiveFailures: analyzer.consecutiveFailures,
  };
}

export function setAnalyzerDisabled(): void {
  analyzer.state = 'disabled';
  analyzer.currentThreadId = null;
}

/** Called by the scheduler; `queued` is the backlog size at that moment. */
export function setAnalyzerQueued(queued: number): void {
  analyzer.queued = Math.max(0, queued);
}

export function analyzerRunStarted(threadId: number): void {
  if (analyzer.state === 'disabled') return;
  analyzer.state = 'analyzing';
  analyzer.currentThreadId = threadId;
}

export function analyzerRunSucceeded(): void {
  analyzer.lastOk = new Date().toISOString();
  analyzer.lastError = null;
  analyzer.consecutiveFailures = 0;
  analyzer.currentThreadId = null;
  if (analyzer.state !== 'disabled') analyzer.state = 'idle';
}

export function analyzerRunFailed(failure: AnalyzerFailure): void {
  analyzer.lastError = failure;
  analyzer.consecutiveFailures += 1;
  analyzer.currentThreadId = null;
  if (analyzer.state !== 'disabled') analyzer.state = 'error';
}

// ---------------------------------------------------------------------------
// failure classification
// ---------------------------------------------------------------------------

/**
 * Thrown by the analyzer when it already knows the bucket (parse failures, timeouts).
 * Structural classification beats string matching, so prefer this where we control
 * the throw site.
 */
export class ClassifiedError extends Error {
  readonly kind: AnalyzerErrorKind;
  constructor(kind: AnalyzerErrorKind, message: string) {
    super(message);
    this.name = 'ClassifiedError';
    this.kind = kind;
  }
}

/**
 * TEXT MATCHING — MAINTENANCE NOTE.
 *
 * For failures that originate inside @anthropic-ai/claude-agent-sdk (or the CLI it
 * spawns) we only get a human-readable string, so these buckets are decided by
 * matching that string case-insensitively. The SDK can reword its errors at any
 * time; if a real failure starts showing up as "unknown" in /api/status, the fix is
 * to add the new wording here.
 *
 * Today's live example this must catch (verbatim from the SDK on a machine with no
 * Claude login): "Failed to authenticate: OAuth session expired and could not be
 * refreshed".
 */
const AUTH_RE = /\bauth\w*|oauth|not logged in|logged out|log in|login|sign(?:ed)? in|unauthorized|401|credential/i;
const BUDGET_RE = /usage limit|quota|credit balance|out of credits|insufficient|billing|upgrade your plan|budget exceeded/i;
const RATE_RE = /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|try again later/i;
const TIMEOUT_RE = /timed? ?out|timeout|etimedout|deadline exceeded|aborted/i;
const BAD_OUTPUT_RE = /json|urgency is not one of|no JSON object|unbalanced|max_turns|max turns/i;

const COPY: Record<AnalyzerErrorKind, { message: string; hint: string; command: string | null }> = {
  auth: {
    message: "Claude isn't signed in on this Mac",
    hint: 'Open Terminal and run: claude auth login',
    command: 'claude auth login',
  },
  timeout: {
    message: 'Claude took too long to review a message',
    hint: 'It will try again on its own in a few minutes. If every message stalls, quit and reopen the app.',
    command: null,
  },
  rate_limit: {
    message: 'Claude is temporarily busy and asked us to slow down',
    hint: 'This usually clears by itself within a few minutes. Nothing for you to do.',
    command: null,
  },
  budget: {
    message: "Claude's usage limit for this plan has been reached",
    hint: 'Prioritizing starts again when the limit resets, or on a higher Claude plan.',
    command: null,
  },
  bad_output: {
    message: "Claude's answer came back in a form this app could not read",
    hint: 'Usually a one-off. It retries in a few minutes, or press Re-analyze on the message.',
    command: null,
  },
  unknown: {
    message: "Claude couldn't review this message",
    hint: 'It will try again in a few minutes. If it keeps happening, quit and reopen the app.',
    command: null,
  },
};

function kindFromText(text: string): AnalyzerErrorKind {
  // Order matters: an auth failure is the one a user must fix by hand, so it wins.
  if (AUTH_RE.test(text)) return 'auth';
  if (BUDGET_RE.test(text)) return 'budget';
  if (RATE_RE.test(text)) return 'rate_limit';
  if (TIMEOUT_RE.test(text)) return 'timeout';
  if (BAD_OUTPUT_RE.test(text)) return 'bad_output';
  return 'unknown';
}

/** Build the user-facing failure record from whatever the analyzer threw. */
export function classifyAnalyzerError(err: unknown): AnalyzerFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const kind = err instanceof ClassifiedError ? err.kind : kindFromText(raw);
  const copy = COPY[kind];
  return {
    kind,
    message: copy.message,
    hint: copy.hint,
    command: copy.command,
    at: new Date().toISOString(),
    // Technical text only — the analyzer never puts Slack transcript content into
    // its error messages (see src/analyzer.ts), so this is safe to surface.
    detail: raw.slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
// workspaces (ingest health)
// ---------------------------------------------------------------------------

export type IngestState = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** What src/ingest.ts reports about one workspace. All fields optional. */
export interface IngestReport {
  state?: IngestState;
  /** Slack team name, once known. Never a token or an id we cannot show. */
  teamName?: string | null;
  /** Plain-English detail for the UI, e.g. "reconnecting (attempt 3)". */
  message?: string | null;
}

/** Shape served by GET /api/status. `registered:false` means "we genuinely do not know". */
export interface WorkspaceHealth {
  key: string;
  /**
   * false = src/ingest.ts has not reported on this workspace, so no connection
   * claim is made at all. The UI must not render a green dot for these.
   */
  registered: boolean;
  state?: IngestState;
  connected?: boolean;
  teamName?: string | null;
  message?: string | null;
  since?: string;
}

const ingestByKey = new Map<string, WorkspaceHealth>();

/**
 * Called by src/ingest.ts from startIngest() and every Socket-Mode lifecycle handler, and
 * by the catch-up sweep, so GET /api/status can report whether Slack is actually connected
 * rather than guessing from which workspaces happen to have sent messages.
 *
 * A workspace that has never reported is serialized as `{ key, registered: false }` with no
 * `connected` field at all — deliberately, because a "connected: true" we cannot verify is
 * worse than no answer, and the UI draws no dot for it.
 *
 * Keep `message` plain-English: it is rendered verbatim to a non-technical user. Never pass
 * a token or raw Slack payload here.
 */
export function registerIngestHealth(workspaceKey: string, report: IngestReport): void {
  const key = String(workspaceKey);
  const prev = ingestByKey.get(key);
  const state = report.state ?? prev?.state;
  ingestByKey.set(key, {
    key,
    registered: true,
    state,
    connected: state === undefined ? undefined : state === 'connected',
    teamName: report.teamName ?? prev?.teamName ?? null,
    message: report.message ?? (report.state !== undefined ? null : (prev?.message ?? null)),
    since: state !== undefined && state !== prev?.state ? new Date().toISOString() : prev?.since,
  });
}

/**
 * One row per configured workspace, plus anything ingest registered under a key we
 * do not know about. Workspaces ingest has not reported on come back as
 * `{ key, registered: false }` with no connection fields at all.
 */
export function listWorkspaceHealth(): WorkspaceHealth[] {
  const out: WorkspaceHealth[] = [];
  const seen = new Set<string>();
  for (const ws of workspaces) {
    seen.add(ws.key);
    out.push(ingestByKey.get(ws.key) ?? { key: ws.key, registered: false });
  }
  for (const [key, health] of ingestByKey) {
    if (!seen.has(key)) out.push(health);
  }
  return out;
}
