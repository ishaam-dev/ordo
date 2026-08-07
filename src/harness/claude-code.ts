/**
 * The `claude-code` provider — the default, and a mechanical wrapping of what
 * src/analyzer.ts and src/chat.ts did inline before. Behaviour with COPILOT_HARNESS
 * unset must be identical to that, byte for byte, which is why the SDK Options built
 * here are the same object shape as the two call sites used to build.
 *
 * What lives here (and nowhere else) is everything that is *Claude's*: the SDK message
 * shapes, the error wording its CLI produces, the `assistant.error` code map, and the
 * `claude auth login` fix command.
 *
 * Read-only is enforced three ways, exactly as before — `tools` restricted to the
 * tool-discovery stub, `canUseTool`, and the `PreToolUse` hook — but the decision behind
 * all three is now the single core gate handed in by resolveToolAccess(). The adapter
 * cannot filter or shortcut it, and the safety proof below runs the real wiring to make
 * sure it is still attached.
 */
import { createRequire } from 'node:module';
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';
import { DISALLOWED_BUILTIN_TOOLS, makeGate, TOOL_DISCOVERY_TOOLS } from './policy.js';
import {
  ClassifiedError,
  HarnessAbortedError,
  type Availability,
  type FailureKind,
  type HarnessEnv,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessProvider,
  type HarnessRequest,
  type HarnessUsage,
  type ProbeContext,
  type ProbeObservation,
  type ReadOnlyAccess,
  type SafetyProof,
  type ToolAccess,
} from './types.js';

// ---------------------------------------------------------------------------
// failure classification — Claude/CLI wording, moved out of health.ts
// ---------------------------------------------------------------------------

/**
 * TEXT MATCHING — MAINTENANCE NOTE.
 *
 * For failures that originate inside @anthropic-ai/claude-agent-sdk (or the CLI it
 * spawns) we only get a human-readable string, so these buckets are decided by matching
 * that string case-insensitively. The SDK can reword its errors at any time; if a real
 * failure starts showing up as "unknown" in /api/status, the fix is to add the new
 * wording here.
 *
 * Today's live example this must catch (verbatim from the SDK on a machine with no
 * Claude login): "Failed to authenticate: OAuth session expired and could not be
 * refreshed".
 */
const AUTH_RE =
  /\bauth\w*|oauth|not logged in|logged out|log in|login|sign(?:ed)? in|unauthorized|401|credential/i;
const BUDGET_RE =
  /usage limit|quota|credit balance|out of credits|insufficient|billing|upgrade your plan|budget exceeded/i;
const RATE_RE = /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|try again later/i;
const TIMEOUT_RE = /timed? ?out|timeout|etimedout|deadline exceeded|aborted/i;

const AUTH_COMMAND = 'claude auth login';

/**
 * The SDK reports a dead Claude login as an ordinary-looking assistant turn whose text is
 * "Failed to authenticate: ..." — plus a structural `error` field on that message. Without
 * this map the panel would render the SDK's plumbing failure as something Claude said.
 * Verified against this machine's actual (logged-out) SDK output.
 */
export function kindOfAssistantError(
  code: string,
): 'auth' | 'budget' | 'rate_limit' | 'bad_output' | 'unknown' {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'auth';
    case 'billing_error':
      return 'budget';
    case 'rate_limit':
    case 'overloaded':
      return 'rate_limit';
    case 'max_output_tokens':
      return 'bad_output';
    default:
      return 'unknown';
  }
}

/**
 * Claude's own text patterns, in the order health.ts always applied them. `bad_output`
 * deliberately is NOT matched here: that bucket describes *our* JSON contract, so core
 * decides it after every provider pattern has had its turn (docs §7).
 */
function kindFromText(text: string): FailureKind | null {
  if (AUTH_RE.test(text)) return 'auth';
  if (BUDGET_RE.test(text)) return 'budget';
  if (RATE_RE.test(text)) return 'rate_limit';
  if (TIMEOUT_RE.test(text)) return 'timeout';
  return null;
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('');
}

/**
 * Per-tool-result cap on what a phase-'end' event may carry when the caller asked for
 * payloads (HarnessRequest.wantToolResults). 256 KiB comfortably holds a full
 * get_thread response while bounding a pathological one.
 */
export const TOOL_RESULT_EVENT_CAP = 262_144;

/** A tool_result's content is either a plain string or an array of typed blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return textFromContent(content);
}

// ---------------------------------------------------------------------------
// options — the same object the two call sites used to build inline
// ---------------------------------------------------------------------------

/** Attach the core decision to BOTH enforcement points. Never filtered, never wrapped. */
function attachGate(options: Options, access: ToolAccess): void {
  const gate = access.gate;
  const nameGate = access.mode === 'read-only' ? access.nameGate : access.gate;

  const canUseTool: CanUseTool = async (toolName) => {
    const decision = gate(toolName);
    return decision.allow === true
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: decision.reason };
  };

  // Second net: PreToolUse fires even for tools auto-allowed by user settings. It runs
  // the *name* policy only — consuming the call budget here would double-count.
  const preToolUseGuard: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      const decision = nameGate(input.tool_name);
      if (decision.allow !== true) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.hookReason,
          },
        };
      }
    }
    return {};
  };

  options.canUseTool = canUseTool;
  options.hooks = { PreToolUse: [{ hooks: [preToolUseGuard] }] };
}

/**
 * MCP tool schemas stay OUT of the context window until the model searches for them.
 *
 * Without this, every run eagerly loaded the schemas of whichever of the user's MCP
 * servers happened to finish connecting before each API call — the claude.ai connector
 * fleet measured ~160k tokens on this machine, i.e. ~80% of the window spent before one
 * word of Slack, and "Continue in Claude Code" reopened those sessions at ~92% full.
 * 'true' rather than 'auto': server attach timing is racy (MCP startup is non-blocking),
 * so a threshold decided against whatever is connected at boot picks eager exactly when
 * the fleet is late. A value already present in the environment wins, so this can be
 * switched off without a code change.
 */
function withMcpDeferralDefault(env: HarnessRequest['env']): Record<string, string> {
  const out = { ...env } as Record<string, string>;
  if (out.ENABLE_TOOL_SEARCH === undefined) out.ENABLE_TOOL_SEARCH = 'true';
  return out;
}

/**
 * Build the SDK options for one run. Exported so the safety proof and the tests can
 * exercise the real wiring without spawning anything.
 */
export function buildOptions(
  req: HarnessRequest,
  abort: AbortController,
  onStderr: (line: string) => void,
): Options {
  const options: Options = {
    cwd: req.cwd,
    abortController: abort,
    maxTurns: req.maxTurns,
    systemPrompt: req.systemPrompt,
    // Inherit the user's global Claude Code config (incl. their MCP servers) but not
    // this repo's project/local settings — an analysis is not a coding session.
    settingSources: ['user'],
    /*
     * The ONLY built-in is ToolSearch, the tool-discovery stub — measured live: without
     * it in `tools`, ENABLE_TOOL_SEARCH is silently ignored and every attached MCP
     * server's schemas load eagerly (~90k tokens observed with this user's connectors,
     * ~3.9k with deferral on). It cannot read or write anything except tool definitions,
     * and the core gate admits it by exact name (policy.ts TOOL_DISCOVERY_TOOLS).
     */
    tools: [...TOOL_DISCOVERY_TOOLS],
    disallowedTools: DISALLOWED_BUILTIN_TOOLS,
    permissionMode: 'default',
    persistSession: true, // required: the chat feature resumes this session id later
    env: withMcpDeferralDefault(req.env),
    stderr: (data: string) => {
      const line = data.trim();
      if (line !== '') onStderr(line.slice(0, 300));
    },
  };

  // Token-wise streaming for the chat panel only — an analysis never rendered deltas.
  if (req.purpose === 'chat') options.includePartialMessages = true;
  if (req.model !== undefined) options.model = req.model;
  if (req.maxBudgetUsd !== undefined) options.maxBudgetUsd = req.maxBudgetUsd;

  if (req.session.id !== null && req.session.mode !== 'seed') {
    options.resume = req.session.id;
    // Forking leaves the analyzer's own transcript untouched and hands us a session id
    // that is ours to keep appending to.
    if (req.session.mode === 'fork') options.forkSession = true;
  }

  // The declared `wireGate` is the code path that actually runs, so it cannot rot into a
  // decorative stub. {mode:'none'} gets a gate that refuses everything.
  if (req.tools.mode === 'read-only') CAPABILITY_TOOLS.wireGate(req.tools, { target: options });
  else attachGate(options, req.tools);
  return options;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function usageOf(message: unknown): HarnessUsage | null {
  const m = message as {
    total_cost_usd?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
  const input = typeof m.usage?.input_tokens === 'number' ? m.usage.input_tokens : null;
  const output = typeof m.usage?.output_tokens === 'number' ? m.usage.output_tokens : null;
  if (cost === null && input === null && output === null) return null;
  return { costUsd: cost, inputTokens: input, outputTokens: output };
}

async function* runClaudeCode(req: HarnessRequest): AsyncGenerator<HarnessEvent> {
  // Our own timer is the only thing that means "timeout": the same controller is also
  // tripped when the caller hangs up (Stop, panel closed, tab gone), and calling that a
  // timeout would put the wrong sentence in front of the user.
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, req.timeoutMs);
  const onOuterAbort = (): void => abort.abort();
  if (req.abort.aborted) abort.abort();
  else req.abort.addEventListener('abort', onOuterAbort, { once: true });

  let sessionId: string | null = null;
  let resultText: string | null = null;
  let resultUsage: HarnessUsage | null = null;
  let sawAssistantText = false;
  let failure: string | null = null;
  let hardFailure: { kind: FailureKind; detail: string } | null = null;
  let lastStderr = '';
  const toolNames = new Map<string, string>();

  const options = buildOptions(req, abort, (line) => {
    lastStderr = line;
  });

  try {
    for await (const message of query({ prompt: req.prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        yield { type: 'session', id: sessionId };
      } else if (message.type === 'stream_event') {
        const ev = message.event as { type?: string; delta?: { type?: string; text?: string } };
        if (
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          typeof ev.delta.text === 'string' &&
          ev.delta.text !== ''
        ) {
          yield { type: 'text', delta: ev.delta.text };
        }
      } else if (message.type === 'assistant') {
        const content = (message.message as { content?: unknown }).content;
        const text = textFromContent(content);
        if (typeof message.error === 'string') {
          // Plumbing failure wearing an assistant message's clothes: keep the text as the
          // technical detail, never as something to show as the model's answer.
          hardFailure = {
            kind: kindOfAssistantError(message.error),
            detail: `${message.error}${text !== '' ? `: ${text}` : ''}`.slice(0, 300),
          };
        } else if (text !== '') {
          sawAssistantText = true;
          yield { type: 'message', text };
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; name?: unknown; id?: unknown };
            if (b?.type === 'tool_use' && typeof b.name === 'string') {
              if (typeof b.id === 'string') toolNames.set(b.id, b.name);
              yield { type: 'tool', name: b.name, phase: 'start' };
            }
          }
        }
      } else if (message.type === 'user') {
        const content = (message.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as {
              type?: string;
              tool_use_id?: unknown;
              is_error?: unknown;
              content?: unknown;
            };
            if (b?.type === 'tool_result') {
              const name =
                typeof b.tool_use_id === 'string' ? (toolNames.get(b.tool_use_id) ?? '') : '';
              if (req.wantToolResults === true) {
                // Raw tool output for core (attacker-controlled bytes — the consumer's
                // contract is in types.ts). Bounded so one huge mailbox page cannot make
                // the event stream the memory hog the context window no longer is.
                const raw = toolResultText(b.content);
                yield {
                  type: 'tool',
                  name,
                  phase: 'end',
                  ok: b.is_error !== true,
                  result: raw.slice(0, TOOL_RESULT_EVENT_CAP),
                  resultTruncated: raw.length > TOOL_RESULT_EVENT_CAP,
                };
              } else {
                yield { type: 'tool', name, phase: 'end', ok: b.is_error !== true };
              }
            }
          }
        }
      } else if (message.type === 'result') {
        sessionId = sessionId ?? message.session_id;
        if (message.subtype === 'success' && !message.is_error) {
          resultText = message.result;
          resultUsage = usageOf(message);
        } else if (message.subtype === 'success') {
          // is_error on a "success" result: the CLI answered, but with its own failure
          // text (auth, billing, ...). Keep that text — it is what gets classified.
          failure = String(message.result ?? 'model result flagged as error').slice(0, 300);
        } else {
          const detail = message.errors.length > 0 ? `: ${message.errors.join('; ')}` : '';
          failure = `${message.subtype}${detail}`.slice(0, 300);
        }
      }
    }
  } catch (err) {
    failure = timedOut
      ? `timed out after ${req.timeoutMs / 1000}s`
      : abort.signal.aborted
        ? 'stopped by the user'
        : err instanceof Error
          ? err.message
          : String(err);
  } finally {
    clearTimeout(timer);
    req.abort.removeEventListener('abort', onOuterAbort);
  }

  // A structural failure wins over anything that happened to be streamed before it —
  // otherwise "Failed to authenticate: ..." renders as a perfectly normal reply.
  if (hardFailure !== null) throw new ClassifiedError(hardFailure.kind, hardFailure.detail);

  // An analysis needs the result message; a chat turn is happy with streamed text.
  const haveOutput = resultText !== null || (req.purpose === 'chat' && sawAssistantText);
  if (!haveOutput) {
    const stderrNote = lastStderr !== '' ? ` [stderr: ${lastStderr}]` : '';
    const nothing =
      req.purpose === 'analysis' ? 'stream ended without a result' : 'stream ended without a reply';
    const detail = `${failure ?? nothing}${stderrNote}`;
    if (timedOut) throw new ClassifiedError('timeout', detail);
    if (abort.signal.aborted) throw new HarnessAbortedError(detail);
    throw new Error(detail);
  }

  // Exactly one 'result', after the stream is drained: a structural failure must beat
  // anything that happened to stream before it.
  yield { type: 'result', text: resultText ?? '', usage: resultUsage, stderrTail: lastStderr };
}

// ---------------------------------------------------------------------------
// the safety proof
// ---------------------------------------------------------------------------

/**
 * Runs the REAL wiring: build the options this adapter would use for an analysis, then
 * drive the resulting `canUseTool` and `PreToolUse` callbacks with the injection corpus.
 *
 * This is deliberately in-process rather than a live model run: it is deterministic,
 * costs nothing, and can therefore run before every boot. It fails — and the harness is
 * marked unavailable — the moment either enforcement point stops being attached, which
 * is the regression this whole layer exists to prevent. `npm run harness:probe
 * claude-code --live` additionally spends one real run against the injection corpus.
 */
const CLAUDE_PROOF: SafetyProof = {
  describe: 'the real canUseTool + PreToolUse wiring refuses every mutating tool name',
  run: async (ctx: ProbeContext): Promise<ProbeObservation> => {
    const { gate, nameGate } = makeGate('analysis');
    const access: ReadOnlyAccess = { mode: 'read-only', gate, nameGate, maxCalls: 5 };
    const abort = new AbortController();
    const options = buildOptions(
      {
        purpose: 'analysis',
        systemPrompt: 'probe',
        prompt: ctx.corpus.join('\n\n'),
        session: { mode: 'seed', id: null },
        tools: access,
        maxTurns: 1,
        timeoutMs: ctx.timeoutMs,
        abort: abort.signal,
        env: ctx.env,
        cwd: ctx.dir,
      },
      abort,
      () => undefined,
    );

    if (typeof options.canUseTool !== 'function') throw new Error('canUseTool is not wired');
    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (typeof hook !== 'function') throw new Error('the PreToolUse hook is not wired');
    // The only built-in allowed through is the tool-discovery stub — anything else in
    // `tools` would be a side-effect-capable tool the gates never see coming.
    if (JSON.stringify(options.tools) !== JSON.stringify(TOOL_DISCOVERY_TOOLS)) {
      throw new Error('tools must be exactly the tool-discovery stub');
    }
    if ((options.disallowedTools ?? []).length === 0) throw new Error('disallowedTools is empty');

    let denied = 0;
    for (const name of ctx.mutatingToolNames) {
      const perCall = await options.canUseTool(name, {}, {
        signal: abort.signal,
      } as Parameters<CanUseTool>[2]);
      if (perCall?.behavior !== 'deny') throw new Error(`canUseTool allowed ${name}`);
      const hooked = (await hook(
        { hook_event_name: 'PreToolUse', tool_name: name, tool_input: {} } as Parameters<HookCallback>[0],
        undefined,
        { signal: abort.signal } as Parameters<HookCallback>[2],
      )) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (hooked.hookSpecificOutput?.permissionDecision !== 'deny') {
        throw new Error(`the PreToolUse hook allowed ${name}`);
      }
      denied += 2;
    }

    // A gate that denies *everything* would pass the test above without protecting
    // anything, so prove it still admits a genuinely read-only lookup.
    const readOnly = await options.canUseTool('mcp__calendar__list_events', {}, {
      signal: abort.signal,
    } as Parameters<CanUseTool>[2]);
    if (readOnly?.behavior !== 'allow') throw new Error('the gate refuses read-only MCP tools too');

    // …and the discovery stub, or MCP deferral silently becomes "no tools at all".
    for (const name of TOOL_DISCOVERY_TOOLS) {
      const discovery = await options.canUseTool(name, {}, {
        signal: abort.signal,
      } as Parameters<CanUseTool>[2]);
      if (discovery?.behavior !== 'allow') throw new Error(`the gate refuses ${name}`);
    }

    return {
      wroteFile: false,
      reachedNetwork: false,
      deniedToolCalls: denied,
      detail: `${denied} refusals across canUseTool and PreToolUse`,
    };
  },
};

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

const CAPABILITY_TOOLS = {
  mode: 'read-only',
  mechanism: 'tools: [ToolSearch] + disallowedTools + canUseTool + PreToolUse hook',
  enforcement: 'core-gate',
  proof: CLAUDE_PROOF,
  wireGate: (access: ReadOnlyAccess, ctx: { target: unknown }): void => {
    attachGate(ctx.target as Options, access);
  },
} as const;

function sdkVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined; // never fatal: the version is a log line, not a gate
  }
}

export const claudeCode: HarnessProvider = {
  identity: {
    id: 'claude-code',
    label: 'Claude Code',
    shortLabel: 'Claude',
    blurb: 'runs on the Claude subscription you are already signed in to',
  },
  capabilities: {
    tools: CAPABILITY_TOOLS,
    resumeSession: true,
    forkSession: true,
    streaming: true,
    mcpInheritance: true,
    // The SDK supports schema-constrained output; we deliberately do not pass a schema,
    // because core parses the text either way and today's behaviour must not change.
    structuredOutput: true,
    billing: 'subscription',
  },
  envPolicy: {
    mode: 'inherit',
    deny: ['CLAUDE', 'ANTHROPIC_BASE_URL'],
    allow: [],
  },

  /**
   * The SDK is a library, not a binary we can probe, and a logged-out Claude is reported
   * accurately at run time as an `auth` failure with the right fix command. Claiming
   * "unavailable" here would stop the analyzer for a condition we cannot actually detect
   * without spending a run, so this stays optimistic — exactly as it always has been.
   */
  available: async (_env: HarnessEnv): Promise<Availability> => ({ ok: true, version: sdkVersion() }),

  run: (req: HarnessRequest) => runClaudeCode(req),

  classifyError: (err: unknown): HarnessFailure => {
    const raw = err instanceof Error ? err.message : String(err);
    const kind = err instanceof ClassifiedError ? err.kind : kindFromText(raw);
    return {
      kind: kind ?? 'unknown',
      detail: raw,
      command: kind === 'auth' ? AUTH_COMMAND : null,
    };
  },
};
