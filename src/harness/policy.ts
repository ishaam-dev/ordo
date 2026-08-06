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
  if (!toolName.startsWith('mcp__')) return false;
  return !MUTATION_NAME_RE.test(toolName);
}

// ---------------------------------------------------------------------------
// per-purpose wording — kept verbatim from the two call sites it replaces
// ---------------------------------------------------------------------------

/** Read-only MCP lookup budget per run. */
export const MAX_TOOL_CALLS = { analysis: 5, chat: 8 } as const;

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
} as const;

const ALLOW: ToolDecision = { allow: true };

/** A gate that refuses everything, for harnesses that run with no tools at all. */
export function denyAllGate(purpose: 'analysis' | 'chat'): ToolGate {
  const w = WORDING[purpose];
  return () => ({ allow: false, reason: w.denied, hookReason: w.hook });
}

/**
 * The core gate: name policy plus a call budget. `gate` counts calls (it is what the
 * harness's per-call permission callback must consult); `nameGate` is the stateless
 * name check for a second enforcement net, which must never consume budget.
 */
export function makeGate(purpose: 'analysis' | 'chat'): { gate: ToolGate; nameGate: ToolGate } {
  const w = WORDING[purpose];
  const deny = (reason: string): ToolDecision => ({ allow: false, reason, hookReason: w.hook });
  let calls = 0;
  return {
    gate: (toolName: string): ToolDecision => {
      if (!isToolAllowed(toolName)) return deny(w.denied);
      calls += 1;
      if (calls > MAX_TOOL_CALLS[purpose]) return deny(w.budget);
      return ALLOW;
    },
    nameGate: (toolName: string): ToolDecision => (isToolAllowed(toolName) ? ALLOW : deny(w.denied)),
  };
}

/**
 * capabilities → the access this run gets. The single place that maps a provider's
 * declared posture onto a request, and the reason "forgetting to be safe" is not an
 * available mistake: anything that is not a *proven* read-only harness gets no tools.
 */
export function resolveToolAccess(
  provider: HarnessProvider,
  purpose: 'analysis' | 'chat',
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
