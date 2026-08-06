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
 *
 * HARNESS SPLIT (docs/harness-providers.md §3): the failure *buckets* and the plain-English
 * copy are harness-independent and live here (and in src/harness/copy.ts). Deciding which
 * bucket a given error text belongs to is harness-SPECIFIC — those patterns moved into the
 * provider, because "Failed to authenticate: OAuth session expired" is Claude's wording,
 * not ours. `bad_output` stays here: it describes our own JSON contract.
 */

import { workspaces } from './config.js';
import { copyFor } from './harness/copy.js';
import { activeHarness } from './harness/index.js';
import {
  ClassifiedError,
  HarnessUnavailableError,
  type FailureKind,
  type HarnessProvider,
} from './harness/types.js';

// ---------------------------------------------------------------------------
// analyzer
// ---------------------------------------------------------------------------

export type AnalyzerState = 'idle' | 'analyzing' | 'disabled' | 'error';

/**
 * Failure buckets. `message`/`hint` are shown verbatim to a non-technical user, so
 * they must stay jargon-free (no "OAuth", "daemon", "SDK", "token", "stderr").
 *
 * The union itself is the UI contract and now lives in src/harness/types.ts (as
 * `FailureKind`) so that providers can classify into it without importing this module.
 * Re-exported under its old name so no call site had to change:
 *   'auth'       not signed in to the harness on this machine
 *   'timeout'    the run exceeded its wall-clock budget
 *   'rate_limit' temporarily throttled; clears by itself
 *   'budget'     plan/usage/credit cap reached
 *   'bad_output' the model replied, but not with the JSON we require
 *   'unknown'    anything we could not place
 */
export type AnalyzerErrorKind = FailureKind;

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
  /**
   * Why the analyzer is off, when it is off for a reason the user can act on — today
   * only the per-token spend guard (docs/harness-providers.md §6). null otherwise.
   */
  note: string | null;
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
  note: null,
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
    note: analyzer.note,
    queued: analyzer.queued,
    lastOk: analyzer.lastOk,
    lastError: analyzer.lastError === null ? null : { ...analyzer.lastError },
    currentThreadId: analyzer.currentThreadId,
    consecutiveFailures: analyzer.consecutiveFailures,
  };
}

export function setAnalyzerDisabled(note: string | null = null): void {
  analyzer.state = 'disabled';
  analyzer.note = note;
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
 * Thrown wherever we already know the bucket (parse failures, timeouts). Structural
 * classification beats string matching, so prefer this where we control the throw site.
 * Defined in src/harness/types.ts — where providers can throw it without importing this
 * module — and re-exported here so every existing call site is unchanged.
 */
export { ClassifiedError } from './harness/types.js';

/**
 * `bad_output` is the one bucket that stays here: it describes OUR contract ("the model
 * answered, we could not read it"), matches the messages src/harness/json.ts throws, and
 * must mean the same thing for every harness. Every other pattern is the harness's own
 * wording and lives in its provider — see src/harness/claude-code.ts for the Claude table,
 * including the live example "Failed to authenticate: OAuth session expired and could not
 * be refreshed".
 *
 * Order of precedence is preserved exactly: the provider's patterns are tried first, and
 * bad_output only claims what would otherwise have fallen through to `unknown`.
 */
const BAD_OUTPUT_RE = /json|urgency is not one of|no JSON object|unbalanced|max_turns|max turns/i;

/**
 * Build the user-facing failure record from whatever the analyzer or chat threw.
 *
 * The provider decides the bucket and the fix command; src/harness/copy.ts writes the
 * plain-English sentence around them, so a Codex user is never told to run
 * `claude auth login`. With the default harness every string is byte-identical to the
 * table this function used to hold.
 */
export function classifyAnalyzerError(
  err: unknown,
  provider: HarnessProvider = activeHarness(),
): AnalyzerFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const at = new Date().toISOString();
  const name = provider.identity.shortLabel;

  // "This harness cannot run at all" carries its own message and its own fix command.
  if (err instanceof HarnessUnavailableError) {
    const command = err.availability.command ?? null;
    const copy = copyFor('auth', { name, command });
    return {
      kind: 'auth',
      message: err.availability.message ?? copy.message,
      hint: err.availability.hint ?? copy.hint,
      command,
      at,
      detail: raw.slice(0, 300),
    };
  }

  const failure = provider.classifyError(err);
  // A declared kind always wins; text matching is only for what the provider could not place.
  const kind: AnalyzerErrorKind =
    failure.kind === 'unknown' && !(err instanceof ClassifiedError) && BAD_OUTPUT_RE.test(raw)
      ? 'bad_output'
      : failure.kind;
  const copy = copyFor(kind, { name, command: failure.command });
  return {
    kind,
    message: failure.message ?? copy.message,
    hint: failure.hint ?? copy.hint,
    command: failure.command,
    at,
    // Technical text only — the analyzer never puts Slack transcript content into
    // its error messages (see src/analyzer.ts), so this is safe to surface.
    detail: failure.detail.slice(0, 300),
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
