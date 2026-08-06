/**
 * A scriptable fake HarnessProvider.
 *
 * This is the seam the characterization suite could not reach before: `runAnalysisQuery`
 * and `runChatTurn` called the SDK's `query()` directly, so `canUseTool` and the
 * `PreToolUse` hook — two of the three read-only enforcement layers — were never executed
 * by a test. Now core hands every provider a decided `ToolAccess`, and a fake can drive
 * the REAL analyzer and chat code paths while a test watches what the gate does.
 *
 * Every fake goes through `defineHarness()`, so a fake that could not exist in production
 * cannot exist here either.
 */
import { defineHarness } from '../../src/harness/index.js';
import { makeGate } from '../../src/harness/policy.js';
import type {
  HarnessEvent,
  HarnessProvider,
  HarnessRequest,
  ProbeContext,
  ProbeObservation,
  SafetyProof,
  ToolPolicy,
} from '../../src/harness/types.js';

export interface FakeOptions {
  id: string;
  label?: string;
  shortLabel?: string;
  /** Events to yield, or a function of the request (which may call req.tools.gate). */
  script?: HarnessEvent[] | ((req: HarnessRequest) => HarnessEvent[] | Promise<HarnessEvent[]>);
  /** Thrown instead of yielding, after any events the script produced. */
  throws?: () => unknown;
  tools?: ToolPolicy;
  resumeSession?: boolean;
  forkSession?: boolean;
  streaming?: boolean;
  mcpInheritance?: boolean;
  structuredOutput?: boolean;
  billing?: 'subscription' | 'api-key' | 'local' | 'unknown';
  available?: { ok: boolean; message?: string; command?: string; version?: string };
  classify?: (err: unknown) => { kind: string; command: string | null };
}

export interface FakeHarness {
  provider: HarnessProvider;
  /** Every request the analyzer/chat handed this provider, in order. */
  requests: HarnessRequest[];
}

/**
 * A proof that exercises the core gate the same way the real Claude adapter's does:
 * every mutating name in the corpus must be refused by both the counting gate and the
 * stateless name gate, and a genuinely read-only MCP name must still be admitted.
 */
export function coreGateProof(describe: string): SafetyProof {
  return {
    describe,
    run: async (ctx: ProbeContext): Promise<ProbeObservation> => {
      const { gate, nameGate } = makeGate('analysis');
      let denied = 0;
      for (const name of ctx.mutatingToolNames) {
        if (gate(name).allow) throw new Error(`gate allowed ${name}`);
        if (nameGate(name).allow) throw new Error(`nameGate allowed ${name}`);
        denied += 2;
      }
      if (!gate('mcp__calendar__list_events').allow) throw new Error('gate refuses read-only too');
      return { wroteFile: false, reachedNetwork: false, deniedToolCalls: denied, detail: `${denied} refusals` };
    },
  };
}

/** A proof that lies: it claims read-only but refuses nothing. Must be rejected. */
export const LYING_PROOF: SafetyProof = {
  describe: 'claims read-only but refuses nothing',
  run: async (): Promise<ProbeObservation> => ({
    wroteFile: false,
    reachedNetwork: false,
    deniedToolCalls: 0,
    detail: 'nothing was refused',
  }),
};

export function makeFakeHarness(opts: FakeOptions): FakeHarness {
  const requests: HarnessRequest[] = [];
  const tools: ToolPolicy = opts.tools ?? {
    mode: 'read-only',
    mechanism: 'core gate only (test double)',
    enforcement: 'core-gate',
    proof: coreGateProof('the fake wires the core gate'),
    wireGate: () => undefined,
  };

  const provider = defineHarness({
    identity: {
      id: opts.id,
      label: opts.label ?? opts.id,
      shortLabel: opts.shortLabel ?? opts.label ?? opts.id,
      blurb: 'a test double',
    },
    capabilities: {
      tools,
      resumeSession: opts.resumeSession ?? true,
      forkSession: opts.forkSession ?? true,
      streaming: opts.streaming ?? true,
      mcpInheritance: opts.mcpInheritance ?? true,
      structuredOutput: opts.structuredOutput ?? false,
      billing: opts.billing ?? 'subscription',
    },
    envPolicy: { mode: 'inherit', deny: ['FAKE_'], allow: [] },
    available: async () => opts.available ?? { ok: true, version: '0.0.0-test' },
    run: (req: HarnessRequest) => {
      requests.push(req);
      return (async function* () {
        const script =
          typeof opts.script === 'function' ? await opts.script(req) : (opts.script ?? []);
        for (const event of script) yield event;
        if (opts.throws !== undefined) throw opts.throws();
      })();
    },
    classifyError: (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      if (opts.classify !== undefined) {
        const out = opts.classify(err);
        return { kind: out.kind as 'unknown', detail: raw, command: out.command };
      }
      const kind =
        err !== null && typeof err === 'object' && 'kind' in err
          ? ((err as { kind: 'unknown' }).kind ?? 'unknown')
          : /auth|sign in|login/i.test(raw)
            ? ('auth' as const)
            : ('unknown' as const);
      return { kind, detail: raw, command: kind === 'auth' ? 'fake login' : null };
    },
  });

  return { provider, requests };
}

/** The canonical happy analysis result, as one JSON object. */
export function verdictEvents(sessionId: string | null = 'fake-session-1'): HarnessEvent[] {
  return [
    { type: 'session', id: sessionId },
    {
      type: 'result',
      text: '{"urgency":"P1","why":"asked directly","summary":"They need an answer.","suggested_action":"Reply","context_notes":""}',
      usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 20 },
    },
  ];
}
