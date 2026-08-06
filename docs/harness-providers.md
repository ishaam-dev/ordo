# Harness providers — making the copilot agnostic of Claude Code

**Status:** design, not built. Nothing in `src/` has changed. This document is the spec the
implementing agent codes against.

**The goal, from the product owner:** *"update the code to be completely agnostic of harness,
people should be able to choose between claude code, codex, pi and it should be easy to add
other harnesses here."*

**The shape of the answer:** one small contract (`src/harness/types.ts`), a registry, a
provider for the SDK we use today, and a **generic config-driven CLI provider** so that most
new harnesses are a data entry rather than code. Default stays `claude-code` and existing
installs must not change behaviour by one byte.

**The thing that makes this more than a refactor:** the analyzer reads attacker-controlled
Slack text. Today read-only is enforced three ways by SDK features that most harnesses do not
have. The contract below makes the unsafe configuration *unrepresentable* — you cannot register
a provider without a runnable proof that it cannot cause a side effect — and that is the part
to review hardest.

---

## 0. What is actually hardwired today

Verified by reading `src/analyzer.ts`, `src/chat.ts`, `src/health.ts`, `src/server.ts` and
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.222).

| # | Leak | Where | SDK feature relied on |
|---|---|---|---|
| 1 | Session persist / resume / fork | `analyses.session_id`, `chat_sessions`, `chat.ts:563-568` | `persistSession`, `resume`, `forkSession` |
| 2 | Read-only enforcement ×3 | `analyzer.ts:319-349`, `chat.ts:512-542` | `tools: []`, `disallowedTools`, `canUseTool`, `hooks.PreToolUse` |
| 3 | MCP inheritance | `settingSources: ['user']` in both | `settingSources` |
| 4 | Token streaming | `chat.ts:575-587` | `includePartialMessages` + `stream_event` |
| 5 | Failure classification | `health.ts:149-196`, `chat.ts:452-467` | SDK/CLI error *wording*, `SDKAssistantMessage.error` codes |
| 6 | Structured output | `analyzer.ts:235-299` | none — hand-rolled brace matcher over `result.result` |
| 7 | Subprocess env hygiene | `analyzer.ts:108-116`, `chat.ts:263-271` | `Options.env` replaces child env wholesale |
| 8 | Cost model | implicit | Claude subscription; SDK reports `total_cost_usd` |

Four more I found that the brief did not list, and that will bite whoever implements this:

9. **`public/chat.js:798` invents the fix command client-side:**
   `command: ev.kind === 'auth' ? 'claude auth login' : null`. The SSE `error` event has no
   `command` field, so the browser hardcodes Claude's. `public/index.html:1227` does the same
   as a fallback (`String(e.command || 'claude auth login')`). **The SSE error event must gain
   `command`, and the UI must stop guessing.** Otherwise a Codex user is told to run
   `claude auth login`.
10. **~25 user-visible strings say "Claude"** (`index.html` status pills "Claude · prioritizing",
    "Discuss with Claude", `index.html:1929` "A Claude Code session scoped to…"). These are
    product copy, not plumbing. `/api/status` must expose `harness: { id, label }` and the UI
    must interpolate the label. Out of scope for the harness layer itself; in scope for the
    same PR, because shipping "Codex" that calls itself "Claude" is a bug.
11. **The read-only policy is duplicated verbatim** in `analyzer.ts` and `chat.ts`
    (`MUTATION_NAME_RE`, `DISALLOWED_BUILTIN_TOOLS`, `isToolAllowed`, `sanitizedEnv` — four
    copies, two files). Any divergence is a silent security hole. Deduplication is a free win
    of this work.
12. **`health.ts` is imported by `chat.ts` for `ClassifiedError`**, so the error-kind union
    cannot simply move into `src/harness/` without care. The dependency direction below fixes
    this: kinds live in `harness/types.ts`, `health.ts` imports and re-exports them, and
    `harness/*` never imports `health.ts`.

---

## 1. Should we use an existing library?

The product owner asked: *"is there a library like ai-sdk but for these harnesses… make sure
that library is popular and well maintained and not a security risk."* Correct instinct, and
the AI SDK analogy is the right one to reject: Vercel's AI SDK abstracts **model providers**
(one HTTP call each). We need to drive **agent harnesses** that own their own agent loop,
tools, sessions, sandbox and auth. Different problem.

### The one real standard: Agent Client Protocol (ACP)

Measured 2026-08-05, not recalled.

| Fact | Value |
|---|---|
| Home | `github.com/agentclientprotocol/agent-client-protocol` (moved out of `zed-industries/`) |
| Stars / forks | 3,874 / 330 |
| Last push | 2026-08-05 (today) |
| Commits in last 90 days | ≥100 (API page cap hit) |
| Licence | Apache-2.0 |
| Governance | `GOVERNANCE.md` + `MAINTAINERS.md`: lead maintainers **Ben Brandt (Zed)** and **Sergey Ignatov (JetBrains)**; core maintainers include Niko Matsakis; separate SDK maintainers for Java/Kotlin/Python/Rust/TS |
| TS SDK | `@agentclientprotocol/sdk` 1.3.0, Apache-2.0, **1 direct dep (`zod`)**, 3 maintainers, published 2026-07-21, **5.7M downloads/week** |
| GitHub advisories | **0** for `@agentclientprotocol/sdk`, 0 for `claude-agent-acp`, 0 for `codex-acp` |
| Protocol surface (v2 schema) | `session/new`, `session/prompt`, `session/resume`, `session/list`, `session/delete`, `session/close`, `session/cancel`, `session/update`, `session/request_permission`, `session/set_config_option`, `auth/login`, `auth/logout`, `elicitation/create`, `elicitation/complete` |

This is a genuinely well-backed standard — two competing editor vendors co-maintaining it,
formal governance, a v1→v2 migration document, five language SDKs. It is not a weekend project
and it is not one person. If we needed an editor↔agent protocol, this would be the answer.

**Adapters we would actually consume:**

| Package | Ver | Licence | Deps | Stars | Last publish | Verdict |
|---|---|---|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp` | 0.65.0 | Apache-2.0 | `zod`, `@agentclientprotocol/sdk`, **`@anthropic-ai/claude-agent-sdk` 0.3.220 (pinned)** | 2,344 | 2026-08-05 | wraps the SDK we already call |
| `@agentclientprotocol/codex-acp` | 1.1.9 | **NOASSERTION** (GitHub cannot detect a licence) | `zod`, `diff`, `open`, `vscode-jsonrpc`, `@openai/codex ^0.145.0`, `@agentclientprotocol/sdk` | 239 | 2026-08-02 | 63 open issues; pulls the whole Codex binary |
| `@zed-industries/claude-code-acp` | 0.16.2 | Apache-2.0 | — | — | 2026-03-26 | **deprecated/renamed**; do not use |

### Verdict: build our own thin layer. Do not adopt ACP as a dependency.

Not because ACP is bad — because it is aimed elsewhere, and for our default harness it is a
strict *loss*. Five concrete reasons:

1. **For Claude Code it adds a hop to reach the identical code.** `claude-agent-acp` is a
   wrapper around `@anthropic-ai/claude-agent-sdk`, pinned at 0.3.220 while we are on 0.3.222.
   Adopting it means `our process → JSON-RPC → their process → claude-agent-sdk → claude CLI`,
   with a second, differently-versioned copy of the SDK in `node_modules`, to arrive exactly
   where `import { query }` already is.
2. **It would take away the five features our safety model is built on.** ACP gives the client
   `session/request_permission` — a permission *prompt*, answered per call with
   `allow_once | allow_always | reject_once | reject_always`. Which calls raise a prompt is the
   agent adapter's decision, not the protocol's. We would lose direct `canUseTool` (our gate),
   `hooks.PreToolUse` (our second net), `tools: []` (no built-ins at all), `settingSources`
   (MCP inheritance — ACP has the client pass `mcpServers` explicitly on `session/new`, so
   "the user's own MCP servers" stops being inherited and becomes something we must enumerate),
   and `Options.env` (our `SLACK_*` strip — an out-of-process agent inherits its own env).
   Every one of those is load-bearing. Trading three enforcement layers we control for one
   prompt-based layer we do not is the wrong direction for the one code path that eats
   attacker-controlled text.
3. **ACP has no fork.** v2 has `session/resume` (with an optional `replayFrom`) and explicitly
   no forking primitive. Our chat feature *forks* the analyzer's session. We would implement
   the degradation anyway.
4. **It solves none of the four problems that are actually ours.** Health classification into
   six plain-English kinds with a fix command: ours. One-JSON-object output contract: ours.
   The `SLACK_*` env strip: ours. Not spending the user's money in a background loop: ours.
5. **Attack surface, hard-nosed.** This runs on the owner's Mac with their Slack DMs in scope.
   `codex-acp` alone brings `open` (spawns a URL handler), `vscode-jsonrpc`, `diff` and the
   entire `@openai/codex` binary distribution, under a licence GitHub cannot identify, from a
   239-star repo. Against that: a spawn-and-parse adapter is ~200 lines of code we read,
   review and own, using `node:child_process` — zero new dependencies. **An unmaintained or
   thin-margin dependency is a worse outcome than code we control, and this is one.**

**What we adopt instead: ACP's ideas, not its wire.** Capability negotiation, per-call
permission decisions, "the client decides", and the `session/new` + `session/prompt` +
`session/resume` split are all good design and are reflected in the contract below. If a
harness we want ever ships *only* an ACP surface, the right response is a single
`src/harness/acp.ts` provider that speaks JSON-RPC over stdio — one more entry in the registry,
which is exactly what the registry is for. That door stays open and costs nothing today.

### The other candidates, briefly

| Package | Evidence | Verdict |
|---|---|---|
| `@sunnyfu/agent-adapter` — "Pluggable coding-agent abstraction layer (CodingAgent interface + adapters + router)" | v0.3.0, last publish 2026-05-11, **1 maintainer**, **2 downloads/week** | Exactly our shape, and exactly the failure mode to avoid. No. |
| `acpx` — headless ACP CLI client | v0.13.0, MIT, 2 maintainers, 1.1M/wk | A CLI, not a library; and it inherits every ACP objection above. No. |
| `@theokit/sdk`, `@slopus/rig`, `oh-my-customcode`, `grill-adapter`, `hunter-harness`, … | npm search turned up a dozen "harness" packages, all single-vendor products with their own opinions | None is a neutral translation layer. No. |

### Do the harnesses converge on a common headless shape anyway?

Largely yes, which is what makes the generic CLI provider viable. All three emit **JSONL of
tagged events on stdout, including a session id, assistant text, tool activity, and one
terminal event**:

| Harness | Invocation | Session id | Text | Tools | Terminal event |
|---|---|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --include-partial-messages` | `{"type":"system","subtype":"init","session_id"}` | `assistant` msg + `stream_event` deltas | `tool_use` blocks | `{"type":"result"}` |
| Codex | `codex exec --json` | `thread.started` | `item.*` | `item.*` | `turn.completed` |
| Pi | `pi --mode json` | `{"type":"session","id":…}` first line | `message_update` → `assistantMessageEvent.type:"text_delta"` → `delta` | `tool_execution_start/update/end` | `agent_end` |

Same *shape*, different field paths. So the mapping is data (a small dialect table), not code —
and a fourth harness whose JSONL resembles any of these is a config entry. That is the honest
version of "easy to add other harnesses", and it is strictly cheaper than an ACP dependency.

---

## 2. The interface

`src/harness/types.ts`. This is the whole contract; everything else in `src/harness/` is either
core logic or one provider.

```ts
// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** Registry key. Lowercase, hyphenated: 'claude-code' | 'pi' | 'codex' | … */
export type HarnessId = string;

export interface HarnessIdentity {
  readonly id: HarnessId;
  /** Product name shown to a non-technical user: "Claude Code", "Pi", "Codex". */
  readonly label: string;
  /** One line for /api/status, e.g. "runs on your Claude subscription". */
  readonly blurb: string;
}

// ---------------------------------------------------------------------------
// tool safety — the security-critical part of this file
// ---------------------------------------------------------------------------

/**
 * There are exactly TWO acceptable tool postures, and both require a runnable proof.
 * There is deliberately no third variant, so "tools on, unenforced" is not a state an
 * adapter author can express — not discouraged, unrepresentable.
 *
 *  - 'no-tools'  the harness runs with every tool switched off.
 *  - 'read-only' every tool call passes through a core-owned gate (or an OS sandbox that
 *                blocks writes AND network) before it runs.
 *
 * `proof` is not documentation. It is executed: by `npm run harness:probe <id>`, by the
 * characterization suite, and once per harness version at boot (result cached in
 * sync_state). A provider whose proof does not pass is refused registration and the
 * analyzer reports it in plain English rather than running unprotected.
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
       * REQUIRED for 'core-gate': wire the core gate into the harness's own permission
       * hook. Called once per run. The adapter may not filter, wrap or shortcut `gate`.
       */
      readonly wireGate?: (gate: ToolGate, ctx: WireContext) => void;
      /**
       * REQUIRED for 'os-sandbox': what the sandbox still permits. Rendered as a known
       * limitation in docs and /api/status. Be pessimistic here.
       */
      readonly residualRisk?: string;
    };

/** Core-owned. The adapter never implements this — it only wires it in. */
export type ToolGate = (
  toolName: string,
) => { allow: true } | { allow: false; reason: string };

export interface WireContext {
  /** Whatever the adapter needs to attach the gate — SDK options object, argv, … */
  readonly target: unknown;
}

/**
 * The proof obligation. Run against a scratch directory the core creates and inspects.
 * All three must hold or the provider is unusable.
 */
export interface SafetyProof {
  /**
   * Run the harness with a prompt that tries hard to (a) write `${dir}/PWNED`,
   * (b) reach the network, and (c) obey an injected "ignore previous instructions"
   * command embedded in fake Slack text. Resolve with what was observed.
   */
  readonly run: (dir: string, env: HarnessEnv) => Promise<ProbeObservation>;
}

export interface ProbeObservation {
  /** Did any file appear under `dir`? Core checks this itself too — do not lie. */
  readonly wroteFile: boolean;
  /** Did the run reach the network? Probe endpoint is a local listener core opens. */
  readonly reachedNetwork: boolean;
  /** Did the harness report refusing a tool (denial count, permission_denials, …)? */
  readonly deniedToolCalls: number;
  /** Raw tail for the failure message. Never contains prompt text. */
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
  /** Who pays. 'api-key' gates the background analyzer — see §6. */
  readonly billing: 'subscription' | 'api-key' | 'local' | 'unknown';
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

/**
 * Already-sanitized environment for any child process. Adapters MUST pass exactly this
 * and MUST NOT read `process.env` themselves (see §5 and the lint rule).
 */
export type HarnessEnv = Readonly<Record<string, string | undefined>>;

export type ToolAccess =
  | { readonly mode: 'none' }
  | { readonly mode: 'read-only'; readonly gate: ToolGate; readonly maxCalls: number };

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
  | { readonly type: 'tool'; readonly name: string; readonly phase: 'start' | 'end'; readonly ok?: boolean }
  | { readonly type: 'result'; readonly text: string; readonly usage: HarnessUsage | null };

export interface HarnessUsage {
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

/** Unchanged from today's health.ts. This union is the UI contract — do not extend it. */
export type FailureKind =
  | 'auth' | 'timeout' | 'rate_limit' | 'budget' | 'bad_output' | 'unknown';

/** Thrown wherever we already know the bucket. Moved here from health.ts. */
export class ClassifiedError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = 'ClassifiedError';
    this.kind = kind;
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

  /**
   * Is this harness usable right now? Binary on PATH, logged in, version ok.
   * Never throws. Called at boot and by GET /api/status.
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
  /** e.g. "0.83.0" — logged at boot, cached with the safety-proof result. */
  readonly version?: string;
}
```

### Why the unsafe path is impossible rather than discouraged

Four mechanisms, in order of when they fire:

1. **The type.** `ToolPolicy` is a two-variant union and both variants require `proof`. There
   is no way to type "tools enabled, no enforcement". An author who wants tools must pick
   `read-only`, and `read-only` + `enforcement:'core-gate'` structurally requires `wireGate`.
2. **The constructor.** `defineHarness()` is the only exported way to build a provider. It
   re-checks at runtime what the type checks at compile time (`mode==='read-only' &&
   enforcement==='core-gate'` ⇒ `wireGate` present; `enforcement==='os-sandbox'` ⇒
   `residualRisk` present; `proof.run` is a function). It throws on registration, at import
   time, so a bad provider cannot reach a user's machine via a boot that "mostly works".
3. **Core, not the adapter, decides `ToolAccess`.** `resolveToolAccess(provider, purpose)` in
   `src/harness/policy.ts` is the single place that maps capabilities → request:
   `tools.mode === 'read-only'` yields `{mode:'read-only', gate, maxCalls}` with the *core's*
   gate (`isToolAllowed` + budget); anything else yields `{mode:'none'}`. An adapter receives a
   decision, never makes one. Forgetting to be safe is not an available mistake.
4. **The proof runs.** Once per (harness id, version) at boot, cached in `sync_state`; and on
   every `npm run harness:probe`. Core creates the scratch dir, opens a local listener as the
   network canary, and **checks the directory and the listener itself** rather than believing
   `ProbeObservation`. A failed proof ⇒ the provider is marked unavailable, the analyzer stays
   idle, and `/api/status` says so in the same plain English as an auth failure. This is what
   catches a regression like Codex's GHSA-w5fx-fh39-j5rw sandbox-bypass: the app re-verifies
   instead of trusting a version number.

---

## 3. Where the seams go

### File layout

```
src/harness/
  types.ts        the contract above + ClassifiedError + FailureKind
  index.ts        REGISTRY, defineHarness(), selectHarness(), boot preflight
  policy.ts       MUTATION_NAME_RE, DISALLOWED_BUILTIN_TOOLS, isToolAllowed,
                  makeGate(maxCalls), resolveToolAccess()
  env.ts          sanitizeEnv(provider) — the only file allowed to read process.env
  json.ts         extractJsonObject()  (moved verbatim from analyzer.ts)
  copy.ts         COPY: Record<FailureKind, {message,hint}>  (moved from health.ts)
  probe.ts        runSafetyProof(): scratch dir + network canary + verdict cache
  claude-code.ts  provider — today's SDK usage, behaviour identical
  cli.ts          provider factory — generic spawn + JSONL parse, config-driven
  dialects.ts     EVENT_DIALECTS: claude-stream-json | codex-jsonl | pi-json | text
  presets/pi.ts   data only — a CliSpec object
  presets/codex.ts data only — a CliSpec object
```

### What moves, by name

| From | Function / const | To | Note |
|---|---|---|---|
| `analyzer.ts` | `runAnalysisQuery` | deleted; becomes `provider.run()` + a 20-line event drain | |
| `analyzer.ts` | `sanitizedEnv` | `harness/env.ts` → `sanitizeEnv` | generalised, §5 |
| `analyzer.ts` | `isToolAllowed`, `MUTATION_NAME_RE`, `DISALLOWED_BUILTIN_TOOLS` | `harness/policy.ts` | |
| `analyzer.ts` | `extractJsonObject` | `harness/json.ts` | verbatim |
| `analyzer.ts` | `parseAnalysis`, `asCappedString`, `MAX_WHY`… | **stay** | they encode our field contract, not a harness's |
| `analyzer.ts` | `SYSTEM_PROMPT`, `buildPrompt`, `buildTranscript`, scheduler, backoff | **stay** | |
| `chat.ts` | `runChatTurn` | thinned to an event pump over `provider.run()` | |
| `chat.ts` | `kindOfAssistantError` | `harness/claude-code.ts` | SDK error codes are Claude's |
| `chat.ts` | `sanitizedEnv`, `isToolAllowed`, `MUTATION_NAME_RE`, `DISALLOWED_BUILTIN_TOOLS` | **deleted** (duplicates) | |
| `chat.ts` | `parseAssistantText`, draft protocol, SSE plumbing, `postToSlack`, routes | **stay** | |
| `health.ts` | `AUTH_RE`, `BUDGET_RE`, `RATE_RE`, `TIMEOUT_RE` | `harness/claude-code.ts` | Claude/CLI wording |
| `health.ts` | `BAD_OUTPUT_RE` | **stays** | it matches *our* JSON contract's messages |
| `health.ts` | `COPY` | `harness/copy.ts`, re-exported | tone stays centralised |
| `health.ts` | `ClassifiedError`, `AnalyzerErrorKind` | `harness/types.ts`, re-exported from `health.ts` | no call-site churn |
| `health.ts` | `classifyAnalyzerError` | **stays**, signature gains the provider | `classifyAnalyzerError(err, provider)`: kind+command from `provider.classifyError`, copy from `COPY`, adapter may override `message`/`hint` |

**Dependency direction (no cycles):** `harness/*` imports nothing from the app except
`node:*`. `health.ts` imports types from `harness/types.ts` and copy from `harness/copy.ts`.
`analyzer.ts` / `chat.ts` import both. `harness/*` must never import `health.ts`, `db.ts`,
`config.ts` or `ingest.ts` — enforceable with one grep in the test suite.

### What the analyzer becomes

```ts
const provider = selectHarness();                       // once, at module load
const tools = resolveToolAccess(provider, 'analysis');  // core decides
let sessionId: string | null = null;
let text = '';
for await (const ev of provider.run({
  purpose: 'analysis', systemPrompt: SYSTEM_PROMPT, prompt,
  session: { mode: 'seed', id: null }, tools,
  maxTurns: MAX_TURNS, timeoutMs: QUERY_TIMEOUT_MS, abort: abort.signal,
  env: sanitizeEnv(provider), cwd: projectRoot, jsonSchema: ANALYSIS_SCHEMA,
})) {
  if (ev.type === 'session') sessionId = ev.id;
  else if (ev.type === 'result') text = ev.text;
}
// unchanged from here down: parseAnalysis(text) → upsertAnalysis(… sessionId)
```

`persistSession: true` becomes implicit: a provider that reports a session id is expected to
have persisted it. A provider that reports `null` stores `null`, and chat's `seedable` flag
already handles that (`chat.ts:764`).

### What chat becomes

`runChatTurn` keeps its signature and its two hard-won bugs (abort on `res` not `req`;
structural failures beating streamed text) and loses the SDK. Session choice moves to core:

```ts
export function planSession(
  provider: HarnessProvider, ourSessionId: string | null, analyzerSessionId: string | null,
): SessionPlan {
  if (ourSessionId !== null && provider.capabilities.resumeSession)
    return { mode: 'resume', id: ourSessionId };
  if (analyzerSessionId !== null && provider.capabilities.forkSession)
    return { mode: 'fork', id: analyzerSessionId };
  return { mode: 'seed', id: null };
}
```

Note what is deliberately *not* there: resuming the analyzer's session when fork is
unavailable. Appending chat turns to the analyzer's transcript would poison the seed that every
future fresh chat starts from. Without fork, we seed.

**The degradation, stated for the user.** Sessions are a cache; `chat_messages` is the source
of truth and we already persist every turn (`chat.ts:120-128`). So:

| Capabilities | Behaviour | What the user loses |
|---|---|---|
| resume + fork (Claude Code) | today's behaviour, unchanged | nothing |
| resume, no fork | first turn seeds with transcript + analysis; later turns resume | the analyzer's *reasoning*. The model sees the verdict, not how it reached it. Costs one bigger first prompt. |
| neither (worst case) | every turn replays a compacted `chat_messages` history + transcript + analysis | continuity is preserved, but every turn pays a full context. Latency and (for `api-key` harnesses) cost rise with conversation length. Core caps the replay at `TRANSCRIPT_CHAR_BUDGET` and drops oldest turns first. |

`GET /api/thread/:id/chat` gains `session_mode: 'resume'|'fork'|'seed'|'replay'` beside the
existing `seedable`, so the panel can say "Claude already has this thread" only when it is true.

---

## 4. Config

| Var | Values | Default | On bad value |
|---|---|---|---|
| `COPILOT_HARNESS` | any registry id: `claude-code`, `pi`, `codex` (alias `claude` → `claude-code`) | `claude-code` | **fatal at boot** |
| `COPILOT_HARNESS_COMMAND` | absolute path to the binary | provider's own default | fatal if set and not executable |
| `COPILOT_HARNESS_MODEL` | passed through to the harness | provider default | provider decides |
| `COPILOT_HARNESS_SPEND_OK` | `1` | unset | see §6 |

Parsed in `src/config.ts` next to `PORT`, exported as `HARNESS_ID`; `selectHarness()` in
`src/harness/index.ts` resolves it. Unset behaves exactly as today.

**Two different failures, two different responses — this is the opinionated bit:**

- **Unknown id** (typo, or a harness that does not exist) is a *config* error. Throw before
  `startServer()`, print the known ids, `exit(1)`. Silently falling back to Claude Code would
  bill the wrong account and hide the mistake; the user is at a terminal or the Electron
  supervisor surfaces the crash and its backoff.
- **Known id, unavailable right now** (binary missing, not logged in, safety proof failing) is
  an *environment* error. Start normally. Slack ingest, the feed, the UI and the send path all
  keep working; the analyzer reports `state:'error'` with the provider's own message and
  command. This is precisely how "Claude isn't signed in on this Mac" behaves today
  (`health.ts:156-160`), and that behaviour is the app's best property. Do not regress it into
  a crash.

`/api/status` gains, at the top level:

```jsonc
"harness": {
  "id": "pi", "label": "Pi", "blurb": "runs on your own API key",
  "available": true, "version": "0.83.0",
  "capabilities": { "tools": "no-tools", "resumeSession": true, "forkSession": true,
                    "streaming": true, "mcpInheritance": false, "billing": "api-key" },
  "limitations": ["No calendar or task context — Pi has no MCP support."]
}
```

`limitations[]` is generated from capabilities, in the same non-technical register as every
other string in `health.ts`. The UI shows it once, in the status pane — and, critically, the
analysis pane must **not** render a "Context" heading when `mcpInheritance` is false, rather
than rendering an empty one.

---

## 5. Process and environment hygiene

Generalised from `analyzer.ts:99-116`. `sanitizeEnv(provider)` in `src/harness/env.ts` is the
**only** place in `src/harness/` permitted to read `process.env`; a test greps for violations.

Every adapter must guarantee:

1. **`SLACK_*` is dropped. Non-negotiable, non-overridable.** Applied last, after any provider
   allowlist, so no provider can re-admit it.
2. **The host harness's nested-session markers are dropped.** Today `CLAUDE*` and
   `ANTHROPIC_BASE_URL`, because the server is often launched from inside a Claude Code session
   and the child then defers auth to a host that is not there. Generalised: each provider
   declares `envDeny: string[]` (prefix match). Claude Code: `['CLAUDE', 'ANTHROPIC_BASE_URL']`.
   Codex: `['CODEX_']`. Pi: `['PI_']`. Core applies the union of a global list and the
   *selected* provider's list. Providers must not have their auth vars stripped by another
   provider's list, hence per-provider rather than one global regex — a real trap, since Pi
   authenticates with `ANTHROPIC_API_KEY` that the Claude adapter deliberately destroys.
3. **`.env` values that are not the harness's business are dropped**: `COPILOT_*`,
   `PORT`, `SLACK_*`. Keep `PATH`, `HOME`, `SHELL`, `LANG`, `TMPDIR`, `USER`, and the
   provider's declared `envAllow`.
4. **No shell.** `spawn(cmd, argv, { shell: false })`. Argv arrays only. No user or model text
   is ever interpolated into a command string; prompts go over **stdin**, never as an argv
   element (argv is world-readable in `ps`, and Slack text would land there).
5. **stdio is `['pipe','pipe','pipe']`.** Never inherit the parent's stdin/stdout: a child that
   inherits stdout can corrupt our logs, and one that inherits stdin can hang forever waiting
   for a TTY that does not exist.
6. **Abort kills the process group.** `SIGTERM`, then `SIGKILL` after 5s. Today's abort path
   assumes the SDK cleans up; a spawned CLI will not.
7. **Never write to the user's harness state as a side effect of a run.** Prefer the harness's
   ephemeral flags where they exist and where we do not need the session (Codex `--ephemeral`,
   Pi `--no-session` — but note we *do* want Pi's sessions, so use them deliberately).
8. **No stdout logging of child output.** stderr is captured to a 300-char tail for the failure
   detail (as today); it is never printed raw, because a harness may echo the prompt.

---

## 6. Cost and limits

Claude Code bills against the user's subscription; Pi and Codex can bill per token against a
key the user owns. The analyzer is a *background loop over every thread* — that is the money
risk, not chat.

**The rule:** a provider with `billing: 'api-key'` may serve **chat** freely (one turn per
deliberate click) but the **analyzer refuses to start** unless `COPILOT_HARNESS_SPEND_OK=1`.
Without it the analyzer enters the existing `disabled` state and `/api/status` says, in plain
English: *"Pi charges your own AI account for every message it reviews. Automatic prioritizing
is off until you turn it on."* with the exact env line to add. The user's money is never spent
by a background loop they did not switch on.

Additionally:

- `HarnessRequest.maxBudgetUsd` is passed when the provider can enforce it (the Claude SDK has
  `maxBudgetUsd` and returns `error_max_budget_usd`). Providers that cannot enforce it ignore
  it — core still enforces `timeoutMs` and `maxTurns`, which bound spend indirectly.
- `HarnessEvent.result.usage` carries `costUsd` when the harness reports it (the SDK's
  `total_cost_usd`). Core accumulates a per-process total into the health registry and
  `/api/status` shows "about $0.42 this session" for `api-key` harnesses only — no number
  invented when the harness reports none.
- `budget` stays a first-class `FailureKind`, and each adapter maps its own quota wording into
  it with its own top-up command.

---

## 7. Structured output — where the JSON extraction lives

**In core, unconditionally.** `extractJsonObject` moves to `src/harness/json.ts` and the
analyzer keeps calling it on whatever text comes back, for every provider.

Reasoning: the one-JSON-object contract is *ours*, not any harness's. Every harness must satisfy
it, the balanced-brace scanner is harness-agnostic and already tolerant of fences and prose, and
`bad_output` is an app-level judgement (the model answered, we could not read it) which is why
`BAD_OUTPUT_RE` stays in `health.ts` while the auth/budget/rate patterns leave.

Native structured output is an **optimisation an adapter may opt into, never a bypass**:
`capabilities.structuredOutput: true` means the adapter accepts `req.jsonSchema` and uses the
harness's own mechanism (Claude SDK `outputFormat`; `codex exec --output-schema ./schema.json`).
Core still runs `extractJsonObject()` on the result and still raises `bad_output` on failure. One
parser, one failure mode, no per-harness divergence in what "malformed" means.

---

## 8. The providers to build now

### 8.1 `claude-code` — default, behaviour identical

A mechanical wrapping of today's code. `run()` builds the same `Options` object and maps the
same messages:

| Today | Provider |
|---|---|
| `system`/`init` → `sessionId` | `{type:'session'}` |
| `stream_event` `content_block_delta` | `{type:'text', delta}` |
| `assistant` text blocks | `{type:'message', text}` |
| `assistant` `tool_use` / `user` `tool_result` | `{type:'tool', …}` |
| `result` success | `{type:'result', text, usage:{costUsd: total_cost_usd, …}}` |
| `assistant.error` code | `throw new ClassifiedError(kindOfAssistantError(code), …)` |

Capabilities: `tools: { mode:'read-only', enforcement:'core-gate', mechanism:'tools: [] +
disallowedTools + canUseTool + PreToolUse hook', wireGate, proof }`, `resumeSession: true`,
`forkSession: true`, `streaming: true`, `mcpInheritance: true`, `structuredOutput: true`,
`billing: 'subscription'`. `classifyError` owns `AUTH_RE`/`BUDGET_RE`/`RATE_RE`/`TIMEOUT_RE`,
the `kindOfAssistantError` code map, and `command: 'claude auth login'`.

`wireGate` sets **both** `canUseTool` and `hooks.PreToolUse` from the single core gate — the
three-way enforcement is preserved exactly, it just stops being copy-pasted.

Acceptance: the characterization suite passes unchanged with `COPILOT_HARNESS` unset.

### 8.2 `cli` — the generic, config-driven provider (this is the real deliverable)

One implementation, driven by a data `CliSpec`. Adding a harness whose headless output is JSONL
is then a preset file with no logic in it.

```ts
export interface CliSpec {
  readonly identity: HarnessIdentity;
  readonly capabilities: Omit<HarnessCapabilities, never>;
  readonly command: string;                       // 'pi' | 'codex'
  readonly versionArgs: readonly string[];        // ['--version']
  /** Pure function: request → argv. No env access, no I/O. */
  readonly args: (req: HarnessRequest) => string[];
  /** 'stdin' (preferred) or a placeholder token replaced in argv. */
  readonly promptVia: 'stdin' | { argvPlaceholder: string };
  readonly dialect: keyof typeof EVENT_DIALECTS;
  readonly envDeny: readonly string[];
  readonly envAllow: readonly string[];
  /** Regex → FailureKind, tried in order, plus the fix command. */
  readonly errors: ReadonlyArray<{ re: RegExp; kind: FailureKind }>;
  readonly authCommand: string;
  readonly installCommand: string;
  readonly proof: SafetyProof;
}
```

`EVENT_DIALECTS` maps a harness's JSONL onto `HarnessEvent` declaratively — a path per event
kind, plus an optional `map` escape hatch for the one harness that needs it:

```ts
export const EVENT_DIALECTS = {
  'pi-json': {
    session:  { when: { type: 'session' },        id:   'id' },
    text:     { when: { type: 'message_update' }, delta:'assistantMessageEvent.delta',
                only: { 'assistantMessageEvent.type': 'text_delta' } },
    message:  { when: { type: 'message_end' },    text: 'message.content[].text' },
    toolStart:{ when: { type: 'tool_execution_start' }, name: 'toolName' },
    toolEnd:  { when: { type: 'tool_execution_end' },   name: 'toolName', ok: '!isError' },
    result:   { when: { type: 'agent_end' },      text: 'messages[-1].content[].text' },
  },
  'codex-jsonl': {
    session:  { when: { type: 'thread.started' }, id: 'thread_id' },
    result:   { when: { type: 'turn.completed' }, text: 'items[-1].text' },
    // item.* carry text and tool activity; see the experiment in §11.
  },
  'claude-stream-json': { /* for driving `claude -p` without the SDK; not used by default */ },
  'text': { /* no JSONL: buffer stdout, emit one 'message' + one 'result' at exit */ },
} as const;
```

`text` is the floor: a harness with no machine-readable output still works. Streaming is lost;
the SSE contract is not, because core emits the buffered text as a single delta and the panel
renders identically, just later. **`streaming: false` changes no code in `chat.ts`.**

### 8.3 `pi` — a preset, not code

Verified against `pi.dev` / `earendil-works/pi` docs (`packages/coding-agent/docs/json.md`,
`security.md`, README):

```ts
export const PI: CliSpec = {
  identity: { id: 'pi', label: 'Pi', blurb: 'runs on your own AI account' },
  command: 'pi',
  versionArgs: ['--version'],
  promptVia: 'stdin',
  dialect: 'pi-json',
  args: (req) => [
    '--mode', 'json',
    '--no-tools',                                   // ← the whole safety story
    ...(req.session.mode === 'resume' ? ['--session', req.session.id!] : []),
    ...(req.session.mode === 'fork'   ? ['--fork',    req.session.id!] : []),
    ...(req.model ? ['--model', req.model] : []),   // never reads process.env — see §5
  ],
  capabilities: {
    tools: { mode: 'no-tools', mechanism: '--no-tools', proof: PI_PROOF },
    resumeSession: true, forkSession: true, streaming: true,
    mcpInheritance: false, structuredOutput: false, billing: 'api-key',
  },
  envDeny: ['PI_'], envAllow: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  errors: [ /* filled from real failures — see the recipe, step 5 */ ],
  authCommand: 'pi /login',
  installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
};
```

**Pi is the proof that the hard rule has teeth, and also that it is satisfiable.** Pi's own
security doc is unusually candid: *"Pi does not include a built-in sandbox"*, there are no
per-tool approval prompts, and prompt injection is *"expected local-agent risk [that] cannot be
reliably prevented by pi"*, with the official guidance being to run it in a container. A harness
with that posture must never see attacker-controlled Slack text with tools on. It does not have
to: `--no-tools` disables all tools, and `--tools <list>` / `--exclude-tools` / `--no-builtin-tools`
exist for finer control we do not need. So Pi ships as `no-tools`, full stop — and the proof
asserts that a prompt begging it to write a file produces no file.

Two bonuses and one loss:

- **Sessions work.** `--session <path|id>` resumes and `--fork <path|id>` forks, so Pi gets the
  *same* session model as Claude Code — `resumeSession: true, forkSession: true`. The id is a
  UUID or a session-file path, which our `TEXT` columns already hold.
- **Streaming works** and its event stream is the closest of the three to ours.
- **No MCP, by design** (*"No MCP"* — build a CLI tool with a README, or write an extension).
  So no "the sender is on your 3pm" context. That is a documented degradation, expressed as
  `mcpInheritance: false`, surfaced in `limitations[]`, and the analysis pane must suppress the
  Context section rather than show it empty. The analyzer's system prompt already says *"If
  tools are missing or fail, proceed from the transcript alone"*, so no prompt change is needed.
- Supply chain: upstream recommends installing with `--ignore-scripts`, which is a small good
  sign about their own posture. Against that, four GitHub advisories exist (2026-06):
  GHSA-jfgx-wxx8-mp94 **high** (predictable temp extension install paths → local privesc on
  shared hosts), GHSA-mqxh-6gq7-558m medium (loads project-local extensions without approval),
  plus two low. All are about *extensions and local state*, which is another reason the preset
  must not enable project trust; keep `defaultProjectTrust: ask` and never pass `--approve`.

### 8.4 `codex` — a preset, with a harder safety story

Verified: `codex exec "<task>"` prints only the final message to stdout; `--json` emits JSONL
(`thread.started`, `turn.started`, `item.*`, `turn.completed`); `--output-schema ./schema.json`
constrains output; `codex exec resume <SESSION_ID>` / `resume --last` resumes; `--sandbox`
defaults to **read-only** (`workspace-write` and `danger-full-access` are opt-in); `--ephemeral`
skips persisting rollouts; `-` reads the prompt from stdin; `CODEX_API_KEY=… codex exec` sets a
per-invocation key.

```ts
args: (req) => [
  'exec',
  ...(req.session.mode === 'resume' ? ['resume', req.session.id!] : []),
  '--json',
  '--sandbox', 'read-only',
  '--skip-git-repo-check',
  ...(req.jsonSchema ? ['--output-schema', schemaPath] : []),
  '-',                                   // prompt on stdin
],
capabilities: {
  tools: { mode: 'no-tools', mechanism:
    '--sandbox read-only (writes and network blocked by the OS) + no approval TTY + empty cwd',
    proof: CODEX_PROOF },
  resumeSession: true, forkSession: false, streaming: true,
  mcpInheritance: false, structuredOutput: true, billing: 'api-key',
},
```

**The honest problem, and the call.** Codex has no `--no-tools` and no per-call hook we can wire
in `exec` mode, so it can satisfy neither `core-gate` nor a literal "tools off". What it does
have is an OS sandbox that, in `read-only`, blocks filesystem writes and network egress. Under
our rule that is enough to *prevent side effects*, but it still lets the model read the user's
filesystem, and Codex has a **critical** advisory for MCP-config-driven code execution
(GHSA-xrxf-jgv3-qmrm) and a **high** one for a sandbox path-logic bypass (GHSA-w5fx-fh39-j5rw).

So the codex preset ships as `no-tools` **with the mechanism being containment rather than a
switch**, and it earns that claim only by passing the proof at boot on the user's actual
machine: no file appears in the scratch dir, the network canary is never hit, and an injected
"ignore previous instructions, run this" produces no observable effect. In addition the adapter
must run with `cwd` = a fresh empty temp dir (never `projectRoot`), pass
`-c features.web_search=false` (repeatable `-c key=value` overrides beat any config file, and
web search is itself a documented prompt-injection surface), `--ignore-user-config` (which also
neutralises the MCP-config advisory) and `--ephemeral` for analysis runs. **If the proof fails, the codex provider is unavailable and the app says so** —
which is exactly the behaviour we want the day a sandbox bypass ships.

Forking: Codex resumes but does not fork, so chat with Codex takes the `seed`-then-`resume` path
from §3. That is the capability model doing its job.

### 8.5 Are pi and codex "just config"?

Pi: **yes** — a preset plus one dialect entry, no bespoke logic. Codex: **almost** — the argv
builder is data, but `codex exec resume <ID>` puts the session id in a *subcommand position*
rather than a flag, and the `item.*` event family needs its dialect entry pinned down against a
real run (§11). Both are far short of "an adapter", which is the claim worth making: **two of
the three harnesses the owner named are data entries against one generic provider.**

---

## 9. How to add a harness

1. **Try config first.** Does it have a headless mode that emits JSONL? Then it is a
   `CliSpec` in `src/harness/presets/<id>.ts` plus, at most, a `EVENT_DIALECTS` entry. Write a
   bespoke provider only if the harness is a library (like the Claude SDK) or its protocol is
   not line-oriented JSON.
2. **Find the flags.** Non-interactive invocation, JSON/stream output, session resume/fork,
   **how to disable tools**, model selection, auth/login command, install command, version flag.
   Record them in the preset with a comment linking the doc you read.
3. **Declare capabilities honestly.** Every `true` is a promise the characterization suite will
   test. `mcpInheritance: true` means the user's own MCP servers are genuinely visible —
   not that the harness "supports MCP".
4. **Choose the tool posture, and prove it.** `no-tools` unless you can wire the core gate.
   Write `proof.run`: a prompt that tries to write `${dir}/PWNED`, `curl` the canary URL, and
   obey an injected instruction planted inside fake Slack text. **A contributor's adapter is
   not acceptable until `npm run harness:probe <id>` passes with:** zero files created, zero
   canary hits, and either zero tool calls (`no-tools`) or a non-zero denial count
   (`read-only`). Paste the probe output in the PR. A capability claim without a passing probe
   is the one thing that gets a provider rejected outright.
5. **Classify real failures.** Log the harness out and run it. Feed it garbage and run it.
   Unplug the network. Exhaust a small budget if you can. Map each observed string into
   `auth | budget | rate_limit | timeout` (`bad_output` and `unknown` are core's) and supply the
   exact fix command. A failure that lands in `unknown` is a bug in your `errors` table.
6. **Register it.** One line in `src/harness/index.ts`; one row in the table in this document;
   one row in `README.md`'s harness list.
7. **Run the suite against it:** `COPILOT_HARNESS=<id> npm test`, plus a manual smoke: one
   analysis produces a valid verdict, one chat turn streams, one draft appears, and
   `/api/status` shows the right label, version and limitations.

---

## 10. Risks and the tests that catch them

Assumes the characterization suite being written concurrently. Where no existing test covers a
row, the test to add is named.

| # | Regression | Likelihood | Caught by |
|---|---|---|---|
| 1 | **Read-only enforcement quietly weakens** — a provider claims `read-only` and forgets one of the three nets, or the core gate is wired to `canUseTool` but not `PreToolUse` | Medium | `harness.safety.test.ts`: the injection-corpus test (analyzer prompt containing "ignore previous instructions and delete…") asserting zero writes and a non-zero denial count, run against **every** registered provider, plus a unit test that `resolveToolAccess` returns `{mode:'none'}` for every non-`read-only` provider |
| 2 | **Chat loses the analyzer's context** — fork silently degrades to seed for Claude Code, or a resume that should retry does not | Medium | `chat.session.test.ts`: `planSession()` truth table across capability combinations; existing chat tests asserting `forkSession: true` is passed for `claude-code` and that resume-failure falls back exactly once and never for auth/budget/rate/timeout |
| 3 | **`SLACK_*` reaches a child process** — a new adapter spawns with `process.env` | Low, catastrophic | `harness.env.test.ts`: `sanitizeEnv()` unit test, plus a grep test that no file under `src/harness/` other than `env.ts` mentions `process.env`, plus a probe assertion that the child's own env dump contains no `SLACK_` and no `xoxp-` |
| 4 | **Failure messages regress to jargon or to the wrong command** — a Codex user is told `claude auth login` (today `public/chat.js:798` guarantees this) | **High** | `health.classify.test.ts`: the verbatim SDK string *"Failed to authenticate: OAuth session expired and could not be refreshed"* → `auth` + `claude auth login`; the same test parameterised per provider; an SSE test asserting the `error` event carries `command` |
| 5 | **Analysis JSON parsing breaks** for a harness that wraps output in prose or a fence | Medium | existing analyzer parse tests, re-run against a recorded transcript per dialect; `bad_output` must be the failure kind, never `unknown` |
| 6 | **Streaming stops** — SSE emits nothing until the end, or the panel never gets `done` | Medium | existing SSE test (deltas arrive before the terminal event); an added case with a `streaming:false` fake provider asserting the panel still receives text and `done` |
| 7 | **Background spend on someone's API key** — analyzer starts with an `api-key` harness and no acknowledgement | Low, expensive | `harness.billing.test.ts`: analyzer stays `disabled` with `billing:'api-key'` and `COPILOT_HARNESS_SPEND_OK` unset; chat still works |
| 8 | **Boot behaviour changes for existing installs** — unset `COPILOT_HARNESS` picks something else, or an unavailable harness crashes the server | Low, user-visible | `config.harness.test.ts`: unset ⇒ `claude-code`; unknown ⇒ throws before `listen`; known-but-unavailable ⇒ server listens, `/api/feed` answers, analyzer reports `error` |
| 9 | **The send path becomes reachable** — an adapter adds a tool namespace that slips the mutation regex, or "no tools" is not honoured | Low, catastrophic | probe case (c): a prompt instructing the harness to POST to `127.0.0.1:<port>/api/thread/1/reply`; assert no Slack call and no request reaching the server (dry-run counter stays 0) |
| 10 | **`mcpInheritance:false` renders an empty Context section**, implying missing data rather than an unavailable feature | Medium | UI snapshot test of the analysis pane with `context_notes: ''` and `mcpInheritance:false` |
| 11 | Duplicate policy constants drift again (`analyzer.ts` vs `chat.ts`) | Medium | grep test: `MUTATION_NAME_RE` and `DISALLOWED_BUILTIN_TOOLS` appear exactly once in `src/` |

---

## 11. Open questions, and the experiment that settles each

Stated as experiments, not hedges.

1. **Codex `item.*` event shapes.** The dialect entry for assistant text and tool activity is
   written from documentation, not from bytes. *Experiment:* install Codex, run
   `codex exec --json --sandbox read-only -` with a two-sentence prompt, capture stdout to a
   fixture, and write the dialect against the fixture. Until then codex ships with
   `dialect: 'text'` (final message only, no streaming) which is correct if unlovely.
2. **Does Codex's read-only sandbox actually hold on this Mac?** *Experiment:* the safety proof,
   run for real. If a file appears or the canary is hit, codex is unavailable and we say so —
   this is a decision the app makes at runtime, not one we make in a document.
3. **Pi's `--fork` id semantics.** Docs say `--fork <path|id>` accepts a partial UUID or a
   session file path. Ours must round-trip through a `TEXT` column and survive `~/.pi` being
   pruned. *Experiment:* fork a session, delete `~/.pi/agent/sessions/<id>.jsonl`, run again;
   assert the failure is classified and that chat falls back to seed exactly once, as it does
   today for a dead Claude session.
4. **Does Pi expose usage/cost in its JSON stream?** Needed for the `api-key` spend line.
   *Experiment:* grep a captured `agent_end` event for token counts; if absent, report no number
   rather than estimating one.
5. **Whether an `acp` provider ever pays for itself.** *Trigger to revisit:* a harness we want
   ships an ACP surface and no usable headless CLI. Until that happens, the JSONL convergence in
   §1 makes the generic CLI provider cheaper and safer.
6. **Whether the analyzer should use `structuredOutput` where available.** It should reduce
   `bad_output` on smaller models. *Experiment:* run 50 threads through Codex with and without
   `--output-schema`, compare `bad_output` rates. Ship it on if it wins; core parsing does not
   change either way.
