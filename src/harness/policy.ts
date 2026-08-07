/**
 * The read-only tool policy — the ONE home for what used to be copy-pasted into both
 * src/analyzer.ts and src/chat.ts (`MUTATION_NAME_RE`, `DISALLOWED_BUILTIN_TOOLS`,
 * `isToolAllowed`). Any divergence between those copies was a silent security hole;
 * now there is nothing to diverge.
 *
 * Core decides the `ToolAccess` for every run. An adapter receives a decision and wires
 * it in — it never decides. Read-only access is granted ONLY to a provider whose safety
 * proof has passed in this process; anything else runs with no tools at all.
 */
import { safetyVerdict } from './probe.js';
import type { HarnessProvider, ReadOnlyAccess, ToolAccess, ToolDecision, ToolGate } from './types.js';

/**
 * MCP tool names vary by server, so on top of "MCP-only" we deny anything whose
 * name suggests mutation. Case-insensitive substring check, belt and suspenders.
 */
const MUTATION_NAME_RE =
  /create|send|post|update|delete|write|add|remove|archive|label|draft|schedule|respond|submit/i;

/**
 * The ONE non-MCP name the read-only gate admits: the harness's tool-discovery tool
 * (Claude Code names it ToolSearch). With MCP deferral on, tool schemas stay out of the
 * context window until the model searches for them — the user's claude.ai connectors
 * alone measured ~160k tokens of schemas when loaded eagerly — and a gate that refused
 * discovery would silently turn "read-only tools" into "no tools at all". Discovery only
 * returns tool definitions, touches no data, and never consumes the lookup budget: the
 * budget meters lookups, and finding out that a tool exists is not one.
 */
export const TOOL_DISCOVERY_TOOLS: readonly string[] = ['ToolSearch'];

/** Extra guard on top of `tools: []` — no built-in tool may run even if injected by settings. */
export const DISALLOWED_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'ExitPlanMode',
  'Skill',
  'SlashCommand',
];

export function isToolAllowed(toolName: string): boolean {
  if (TOOL_DISCOVERY_TOOLS.includes(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  return !MUTATION_NAME_RE.test(toolName);
}

/** Every kind of model run core can request. Email is its own purpose because its gate inverts. */
export type RunPurpose = 'analysis' | 'chat' | 'email';

/**
 * The email path runs against mail written by anyone on the internet, and the live Gmail
 * MCP exposes real destructive tools (`apply_sensitive_thread_label` moves a thread to
 * Trash/Spam). The deny-regex above happens to catch today's mutating names — but only by
 * coincidence (`label` is in the list for unrelated reasons), and plausible names like
 * `move_to_trash`, `mark_read` or `mute_thread` would sail through it. So for 'email'
 * runs the gate INVERTS to an allowlist of exact read-only tool suffixes, with the
 * mutation regex kept as the second net behind it (docs/email-ingest.md §10.1). This is a
 * refinement inside the name check, not a third ToolPolicy variant — "tools on,
 * unenforced" stays unrepresentable.
 */
/*
 * Deliberately WITHOUT list_labels: the poller never lists labels, and admitting it
 * would mean carving an exception out of the mutation regex (`label` matches it). The
 * allowlist is the boundary — shrinking it beats weakening the second net.
 */
const EMAIL_TOOL_SUFFIX_ALLOWLIST: ReadonlySet<string> = new Set([
  'get_thread',
  'get_message',
  'search_threads',
]);

export function isToolAllowedFor(purpose: RunPurpose, toolName: string): boolean {
  if (purpose !== 'email') return isToolAllowed(toolName);
  if (TOOL_DISCOVERY_TOOLS.includes(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  const suffix = toolName.slice(toolName.lastIndexOf('__') + 2);
  if (!EMAIL_TOOL_SUFFIX_ALLOWLIST.has(suffix)) return false;
  return !MUTATION_NAME_RE.test(toolName);
}

// ---------------------------------------------------------------------------
// per-purpose wording — kept verbatim from the two call sites it replaces
// ---------------------------------------------------------------------------

/**
 * Read-only MCP lookup budget per run.
 *
 * This is a backstop, not a discouragement: the analysis prompt tells the model to use
 * tools as needed and leaves the choice of tool to it, so the number only has to be high
 * enough that a genuinely thorough triage never hits it, and low enough that a confused
 * run cannot spend twenty lookups going in circles. Ten fits a thread that warrants
 * checking a calendar, a couple of mail threads, a task and a meeting note, and still
 * lands inside the analyzer's 3-minute wall.
 *
 * COUPLED CONSTANT: the run's `maxTurns` must stay above this — a tool call costs a turn,
 * and running out of turns is a hard failure ("stream ended without a result", retried in
 * five minutes) whereas running out of budget is graceful (the gate's refusal tells the
 * model to produce its verdict now). Both call sites keep turns = budget + 8: with MCP
 * deferral on, tool-discovery calls cost turns too (but never budget), so the headroom
 * covers a few discoveries plus the final answer.
 */
export const MAX_TOOL_CALLS = { analysis: 10, chat: 8, email: 12 } as const;

const WORDING = {
  analysis: {
    denied: 'Analyzer sessions are read-only; this tool is not permitted.',
    hook: 'Analyzer sessions are read-only; only non-mutating MCP tools are allowed.',
    budget: `Tool budget of ${MAX_TOOL_CALLS.analysis} lookups is spent — produce the JSON verdict now.`,
  },
  chat: {
    denied:
      'This chat is read-only: it cannot create, send or modify anything (including Slack messages). Propose a draft instead — the user sends it.',
    hook: 'Chat sessions are read-only; only non-mutating MCP tools are allowed. Slack posting is not a tool.',
    budget: `Tool budget of ${MAX_TOOL_CALLS.chat} lookups is spent for this turn — answer from what you have.`,
  },
  email: {
    denied:
      'Email runs may only read mail (search_threads, get_thread, get_message). Nothing that creates, labels, moves or deletes anything is permitted.',
    hook: 'Email runs are read-only against an explicit allowlist of Gmail read tools.',
    budget: `Tool budget of ${MAX_TOOL_CALLS.email} lookups is spent — produce the JSON verdicts now from what you have.`,
  },
} as const;

const ALLOW: ToolDecision = { allow: true };

/** A gate that refuses everything, for harnesses that run with no tools at all. */
export function denyAllGate(purpose: RunPurpose): ToolGate {
  const w = WORDING[purpose];
  return () => ({ allow: false, reason: w.denied, hookReason: w.hook });
}

/**
 * The core gate: name policy plus a call budget. `gate` counts calls (it is what the
 * harness's per-call permission callback must consult); `nameGate` is the stateless
 * name check for a second enforcement net, which must never consume budget. Discovery
 * calls (TOOL_DISCOVERY_TOOLS) pass the name policy but are exempt from the budget —
 * they fetch tool definitions, not data, and metering them would spend lookups on
 * finding out what a lookup could be.
 */
export function makeGate(purpose: RunPurpose): { gate: ToolGate; nameGate: ToolGate } {
  const w = WORDING[purpose];
  const deny = (reason: string): ToolDecision => ({ allow: false, reason, hookReason: w.hook });
  let calls = 0;
  return {
    gate: (toolName: string): ToolDecision => {
      if (!isToolAllowedFor(purpose, toolName)) return deny(w.denied);
      if (TOOL_DISCOVERY_TOOLS.includes(toolName)) return ALLOW;
      calls += 1;
      if (calls > MAX_TOOL_CALLS[purpose]) return deny(w.budget);
      return ALLOW;
    },
    nameGate: (toolName: string): ToolDecision =>
      isToolAllowedFor(purpose, toolName) ? ALLOW : deny(w.denied),
  };
}

/**
 * capabilities → the access this run gets. The single place that maps a provider's
 * declared posture onto a request, and the reason "forgetting to be safe" is not an
 * available mistake: anything that is not a *proven* read-only harness gets no tools.
 */
export function resolveToolAccess(
  provider: HarnessProvider,
  purpose: RunPurpose,
): ToolAccess {
  const policy = provider.capabilities.tools;
  if (policy.mode === 'read-only' && safetyVerdict(provider.identity.id) === 'passed') {
    const { gate, nameGate } = makeGate(purpose);
    const access: ReadOnlyAccess = {
      mode: 'read-only',
      gate,
      nameGate,
      maxCalls: MAX_TOOL_CALLS[purpose],
    };
    return access;
  }
  return { mode: 'none', gate: denyAllGate(purpose) };
}
