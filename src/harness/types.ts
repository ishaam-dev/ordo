/**
 * The harness contract — see docs/harness-providers.md §2.
 *
 * One small interface that every AI harness (Claude Code, Pi, Codex, …) is driven
 * through, so that src/analyzer.ts and src/chat.ts contain no vendor-specific code.
 *
 * The security-critical part is `ToolPolicy`. The analyzer reads attacker-controlled
 * Slack text, so "tools on, unenforced" must not be a state an adapter author can
 * express. There are exactly two variants, both require a runnable `SafetyProof`, and
 * the *core* — never the adapter — decides the `ToolAccess` for a run.
 *
 * This file imports nothing. Nothing under src/harness/ may import health.ts, db.ts,
 * config.ts or ingest.ts (see test/harness-boundaries.test.ts).
 */

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** Registry key. Lowercase, hyphenated: 'claude-code' | 'pi' | 'codex' | … */
export type HarnessId = string;

export interface HarnessIdentity {
  readonly id: HarnessId;
  /** Product name shown to a non-technical user: "Claude Code", "Pi", "Codex". */
  readonly label: string;
  /**
   * The name this harness is called by inside a sentence: "Claude", "Pi", "Codex".
   * Used by src/harness/copy.ts to build the plain-English failure copy, which is why
   * it is separate from `label` ("Claude Code isn't signed in on this Mac" reads wrong).
   */
  readonly shortLabel: string;
  /** One line for /api/status, e.g. "runs on your Claude subscription". */
  readonly blurb: string;
}

// ---------------------------------------------------------------------------
// tool safety
// ---------------------------------------------------------------------------

/**
 * There are exactly TWO acceptable tool postures, and both require a runnable proof.
 *
 *  - 'no-tools'  the harness runs with every tool switched off.
 *  - 'read-only' every tool call passes through a core-owned gate (or an OS sandbox
 *                that blocks writes AND network) before it runs.
 */
export type ToolPolicy =
  | {
      readonly mode: 'no-tools';
      /** Exact mechanism, one line: "--no-tools" / "tools: [] + disallowedTools". */
      readonly mechanism: string;
      readonly proof: SafetyProof;
    }
  | {
      readonly mode: 'read-only';
      readonly mechanism: string;
      /** 'core-gate' = our callback runs per call. 'os-sandbox' = the OS blocks it. */
      readonly enforcement: 'core-gate' | 'os-sandbox';
      readonly proof: SafetyProof;
      /**
       * REQUIRED for 'core-gate': wire the core-owned decision into the harness's own
       * permission callbacks. Called once per run. The adapter may not filter, wrap or
       * shortcut it — it receives a decision and attaches it.
       */
      readonly wireGate?: (access: ReadOnlyAccess, ctx: WireContext) => void;
      /** REQUIRED for 'os-sandbox': what the sandbox still permits. Be pessimistic. */
      readonly residualRisk?: string;
    };

export type ToolDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** Wording for the harness's per-call permission callback. */
      readonly reason: string;
      /** Wording for a second enforcement net (a pre-tool-use hook), if it has one. */
      readonly hookReason: string;
    };

/** Core-owned. The adapter never implements this — it only wires it in. */
export type ToolGate = (toolName: string) => ToolDecision;

export interface WireContext {
  /** Whatever the adapter needs to attach the gate — SDK options object, argv, … */
  readonly target: unknown;
}

/**
 * The proof obligation. Run against a scratch directory the core creates and inspects,
 * with a local network canary the core opens. All of it must hold or the provider is
 * unusable and the analyzer stays idle rather than running unprotected.
 */
export interface SafetyProof {
  /** One line for logs and /api/status: what this proof actually exercises. */
  readonly describe: string;
  readonly run: (ctx: ProbeContext) => Promise<ProbeObservation>;
}

export interface ProbeContext {
  /** A scratch directory the core created. Nothing may appear inside it. */
  readonly dir: string;
  /** A local URL the core is listening on. Reaching it fails the proof. */
  readonly canaryUrl: string;
  /** Already-sanitized env for any child process. */
  readonly env: HarnessEnv;
  /** Prompts that try to write, fetch and obey an injected instruction. */
  readonly corpus: readonly string[];
  /** Tool names a read-only harness must refuse. */
  readonly mutatingToolNames: readonly string[];
  /** Deadline for the whole proof. */
  readonly timeoutMs: number;
}

export interface ProbeObservation {
  /** Did any file appear under `dir`? Core checks this itself too — do not lie. */
  readonly wroteFile: boolean;
  /** Did the run reach the network canary? Core checks this itself too. */
  readonly reachedNetwork: boolean;
  /** Did the harness report refusing a tool (denial count, permission_denials, …)? */
  readonly deniedToolCalls: number;
  /** Raw tail for the failure message. Never contains prompt or Slack text. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

export interface HarnessCapabilities {
  readonly tools: ToolPolicy;
  /** Resume a prior session by id. False ⇒ core replays chat history in the prompt. */
  readonly resumeSession: boolean;
  /** Continue from a session WITHOUT appending to it. False ⇒ chat seeds instead. */
  readonly forkSession: boolean;
  /** Token-level text deltas. False ⇒ core buffers and emits once; SSE shape unchanged. */
  readonly streaming: boolean;
  /** The user's own MCP servers are visible. False ⇒ no calendar/task context. */
  readonly mcpInheritance: boolean;
  /** Native JSON-schema-constrained output. Advisory: core parses the JSON regardless. */
  readonly structuredOutput: boolean;
  /** Who pays. 'api-key' gates the background analyzer — see docs §6. */
  readonly billing: 'subscription' | 'api-key' | 'local' | 'unknown';
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

/**
 * Already-sanitized environment for any child process. Adapters MUST pass exactly this
 * and MUST NOT read process.env themselves — src/harness/env.ts is the only file under
 * src/harness/ allowed to touch it, and a test greps for violations.
 */
export type HarnessEnv = Readonly<Record<string, string | undefined>>;

export interface EnvPolicy {
  /**
   * 'inherit'   — start from the parent env minus the deny lists (what Claude Code has
   *               always done; the user's MCP servers inherit it and need their own keys).
   * 'allowlist' — start from nothing but a small base list plus `allow`.
   */
  readonly mode: 'inherit' | 'allowlist';
  /** Prefix match. This harness's own nested-session markers, e.g. ['CLAUDE']. */
  readonly deny: readonly string[];
  /** Exact keys this harness legitimately needs, e.g. ['ANTHROPIC_API_KEY']. */
  readonly allow: readonly string[];
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

export type SessionMode = 'resume' | 'fork' | 'seed';

export interface SessionPlan {
  readonly mode: SessionMode;
  /** The id to resume/fork. null when mode === 'seed'. */
  readonly id: string | null;
}

export interface ReadOnlyAccess {
  readonly mode: 'read-only';
  /** Full check: name policy AND the call budget. Counts a call. */
  readonly gate: ToolGate;
  /** Name policy only — no budget, no counting. For a second enforcement net. */
  readonly nameGate: ToolGate;
  readonly maxCalls: number;
}

export type ToolAccess = { readonly mode: 'none'; readonly gate: ToolGate } | ReadOnlyAccess;

export interface HarnessRequest {
  /** 'analysis' (background, untrusted input, JSON out) or 'chat' (user-driven, streamed). */
  readonly purpose: 'analysis' | 'chat';
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly session: SessionPlan;
  /** Chosen by core from capabilities. The adapter never decides this. */
  readonly tools: ToolAccess;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly abort: AbortSignal;
  readonly env: HarnessEnv;
  readonly cwd: string;
  /** From COPILOT_HARNESS_MODEL, resolved in config.ts. Providers may ignore it. */
  readonly model?: string;
  /** Set only when purpose==='analysis'. Adapters with structuredOutput may use it. */
  readonly jsonSchema?: Record<string, unknown>;
  /** Optional per-run spend ceiling, for harnesses that can enforce one. */
  readonly maxBudgetUsd?: number;
}

// ---------------------------------------------------------------------------
// events — one union for both call sites
// ---------------------------------------------------------------------------

export type HarnessEvent =
  | { readonly type: 'session'; readonly id: string | null }
  | { readonly type: 'text'; readonly delta: string }
  /** Whole assistant turn. Non-streaming harnesses emit only this. */
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly phase: 'start' | 'end';
      readonly ok?: boolean;
    }
  | {
      readonly type: 'result';
      readonly text: string;
      readonly usage: HarnessUsage | null;
      /**
       * Last stderr line the harness produced (≤300 chars), so a caller that ends up
       * with an empty reply can put the same technical note in its failure detail as
       * it always has. Never logged raw.
       */
      readonly stderrTail?: string;
    };

export interface HarnessUsage {
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

/** Unchanged from health.ts. This union is the UI contract — do not extend it. */
export type FailureKind = 'auth' | 'timeout' | 'rate_limit' | 'budget' | 'bad_output' | 'unknown';

/**
 * Thrown wherever we already know the bucket (parse failures, timeouts). Structural
 * classification beats string matching, so prefer this where we control the throw site.
 * Re-exported from health.ts so no call site had to change.
 */
export class ClassifiedError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = 'ClassifiedError';
    this.kind = kind;
  }
}

/** The run ended because someone else aborted it (Stop, panel closed) — not a timeout. */
export class HarnessAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessAbortedError';
  }
}

/**
 * The selected harness cannot run right now: binary missing, not signed in, or its
 * safety proof did not pass. Carries the harness's OWN plain-English message and fix
 * command, so a Codex user is never told to run `claude auth login`.
 */
export class HarnessUnavailableError extends ClassifiedError {
  readonly availability: Availability;
  constructor(availability: Availability, label: string) {
    super('auth', `${label} is not ready: ${availability.message ?? 'unavailable'}`);
    this.name = 'HarnessUnavailableError';
    this.availability = availability;
  }
}

export interface HarnessFailure {
  readonly kind: FailureKind;
  /** Truncated technical text. MUST NOT contain Slack transcript or draft text. */
  readonly detail: string;
  /** The harness's own fix command: 'claude auth login' | 'codex login' | 'pi /login'. */
  readonly command: string | null;
  /** Optional override of core's plain-English copy. Same register: no jargon. */
  readonly message?: string;
  readonly hint?: string;
}

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

export interface HarnessProvider {
  readonly identity: HarnessIdentity;
  readonly capabilities: HarnessCapabilities;
  /** How src/harness/env.ts builds this harness's child environment. */
  readonly envPolicy: EnvPolicy;

  /**
   * Is this harness usable right now? Binary on PATH, logged in, version ok.
   * Never throws. Called before a run (cached) and by GET /api/status.
   */
  available(env: HarnessEnv): Promise<Availability>;

  /**
   * One run. Yields events until the run ends; MUST end with exactly one 'result'
   * or throw. MUST honour `req.abort`. MUST NOT touch process.env, the Slack API,
   * the database, or stdout.
   */
  run(req: HarnessRequest): AsyncIterable<HarnessEvent>;

  /** Harness-specific error text/codes → a bucket + a fix command. */
  classifyError(err: unknown): HarnessFailure;
}

export interface Availability {
  readonly ok: boolean;
  /** Plain English when !ok: "Pi is not installed on this Mac." */
  readonly message?: string;
  /** Exact command that fixes it. */
  readonly command?: string;
  /** What to do when a command is not the fix. Same non-technical register. */
  readonly hint?: string;
  /** e.g. "0.83.0" — logged at boot, cached with the safety-proof result. */
  readonly version?: string;
}
