/**
 * The harness registry — selection, the boot preflight, and the readiness cache.
 *
 * ADDING A HARNESS (docs/harness-providers.md §9), in full:
 *   1. write `src/harness/presets/<id>.ts` — a CliSpec: command, argv builder, dialect,
 *      env policy, error table, auth/install commands, and a SafetyProof;
 *   2. add one line to REGISTRY below.
 * That is the whole contract. Everything else — the read-only decision, JSON extraction,
 * failure copy, the spend guard, /api/status — is core and applies automatically.
 *
 * TWO DIFFERENT FAILURES, TWO DIFFERENT RESPONSES:
 *   - an UNKNOWN id is a config error: selectHarness() throws before the server listens,
 *     printing the ids that do exist. Silently falling back to Claude Code would bill the
 *     wrong account and hide the mistake.
 *   - a KNOWN id that is unavailable right now (binary missing, not signed in, safety
 *     proof failing) is an environment error: the app starts normally, Slack ingest and
 *     the feed and the send path all keep working, and the analyzer reports it in plain
 *     English with that harness's own fix command. That is exactly how "Claude isn't
 *     signed in on this Mac" has always behaved, and it is the app's best property.
 */
import { claudeCode } from './claude-code.js';
import { defineCliHarness } from './cli.js';
import { harnessConfigFromEnv, sanitizeEnv, type HarnessConfig } from './env.js';
import { CODEX } from './presets/codex.js';
import { PI } from './presets/pi.js';
import { ensureSafetyProof, safetyResult, type SafetyVerdict } from './probe.js';
import {
  HarnessUnavailableError,
  type Availability,
  type HarnessEnv,
  type HarnessProvider,
  type SessionPlan,
} from './types.js';

// ---------------------------------------------------------------------------
// defineHarness — the only supported way to build a provider
// ---------------------------------------------------------------------------

/**
 * Re-check at runtime what the type system checks at compile time, and throw at import
 * time so a bad provider cannot reach a user's machine via a boot that "mostly works".
 */
export function defineHarness(provider: HarnessProvider): HarnessProvider {
  const where = `harness '${provider.identity?.id ?? '?'}'`;
  const id = provider.identity?.id ?? '';
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${where}: id must be lowercase-hyphenated`);
  for (const field of ['label', 'shortLabel', 'blurb'] as const) {
    if (typeof provider.identity[field] !== 'string' || provider.identity[field] === '') {
      throw new Error(`${where}: identity.${field} is required`);
    }
  }
  const tools = provider.capabilities?.tools;
  if (tools === undefined) throw new Error(`${where}: capabilities.tools is required`);
  if (tools.mode !== 'no-tools' && tools.mode !== 'read-only') {
    throw new Error(`${where}: tools.mode must be 'no-tools' or 'read-only'`);
  }
  if (typeof tools.mechanism !== 'string' || tools.mechanism === '') {
    throw new Error(`${where}: tools.mechanism must say how tools are prevented`);
  }
  if (typeof tools.proof?.run !== 'function') {
    throw new Error(`${where}: tools.proof.run is required — a capability claim without a runnable proof is not acceptable`);
  }
  if (tools.mode === 'read-only') {
    if (tools.enforcement === 'core-gate' && typeof tools.wireGate !== 'function') {
      throw new Error(`${where}: read-only + core-gate requires wireGate`);
    }
    if (tools.enforcement === 'os-sandbox' && (tools.residualRisk ?? '') === '') {
      throw new Error(`${where}: read-only + os-sandbox requires residualRisk`);
    }
  }
  if (provider.envPolicy === undefined) throw new Error(`${where}: envPolicy is required`);
  if (typeof provider.run !== 'function') throw new Error(`${where}: run() is required`);
  if (typeof provider.available !== 'function') throw new Error(`${where}: available() is required`);
  if (typeof provider.classifyError !== 'function') {
    throw new Error(`${where}: classifyError() is required`);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

const CONFIG: HarnessConfig = harnessConfigFromEnv();

/** id → provider. One line per harness. */
export const REGISTRY: Record<string, HarnessProvider> = {
  'claude-code': defineHarness(claudeCode),
  pi: defineHarness(defineCliHarness(PI, CONFIG.command ?? undefined)),
  codex: defineHarness(defineCliHarness(CODEX, CONFIG.command ?? undefined)),
};

/** Friendly spellings that resolve to a registry id. */
const ALIASES: Record<string, string> = { claude: 'claude-code', 'claude-code-sdk': 'claude-code' };

export function harnessIds(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Resolve a configured id to a provider. Throws — loudly — on an unknown id. */
export function selectHarness(id: string = CONFIG.id): HarnessProvider {
  const key = ALIASES[id] ?? id;
  const provider = REGISTRY[key];
  if (provider === undefined) {
    throw new Error(
      `COPILOT_HARNESS="${id}" is not a harness this app knows. ` +
        `Valid values: ${harnessIds().join(', ')} (default: claude-code).`,
    );
  }
  return provider;
}

let active: HarnessProvider | null = null;

/** The provider every run goes through. Resolved once, then cached. */
export function activeHarness(): HarnessProvider {
  if (active === null) active = selectHarness();
  return active;
}

/**
 * Test/boot seam: swap the provider the analyzer and chat drive. Passing null restores
 * the configured one. This is what makes the enforcement path testable end to end — the
 * gap that motivated the whole layer.
 */
export function setActiveHarness(provider: HarnessProvider | null): void {
  active = provider;
  readiness.clear();
}

export function harnessModel(): string | undefined {
  return CONFIG.model ?? undefined;
}

/** COPILOT_HARNESS_SPEND_OK=1 — the acknowledgement a per-token harness needs. */
export function spendAcknowledged(): boolean {
  return CONFIG.spendOk;
}

/** Env for the active harness's child process. Both call sites use exactly this. */
export function sanitizedEnv(): HarnessEnv {
  return sanitizeEnv(activeHarness());
}

// ---------------------------------------------------------------------------
// readiness: available() + the safety proof, cached
// ---------------------------------------------------------------------------

interface Readiness {
  readonly availability: Availability;
  readonly verdict: SafetyVerdict;
  readonly at: number;
}

const readiness = new Map<string, Readiness>();
const OK_TTL_MS = 5 * 60_000;
const BAD_TTL_MS = 30_000;

async function checkReadiness(provider: HarnessProvider): Promise<Readiness> {
  const env = sanitizeEnv(provider);
  let availability = await provider.available(env).catch((err: unknown) => ({
    ok: false,
    message: `${provider.identity.label} could not be checked on this Mac.`,
    command: undefined,
    version: undefined,
    detail: err,
  }));
  let verdict: SafetyVerdict = 'unverified';

  if (availability.ok) {
    // Nothing sees Slack text until the harness has proved it cannot cause a side effect.
    const proof = await ensureSafetyProof(provider, env);
    verdict = proof.verdict;
    if (verdict !== 'passed') {
      availability = {
        ok: false,
        message: `${provider.identity.label} could not prove it runs safely on this Mac, so nothing is being sent to it.`,
        hint:
          `This is a check the app runs itself before any of your messages are shared with ` +
          `${provider.identity.shortLabel}. Update ${provider.identity.shortLabel}, or choose a different assistant in your .env file.`,
        command: undefined,
        version: availability.version,
      };
      console.warn(`[harness] ${provider.identity.id} safety proof failed: ${proof.detail}`);
    }
  }
  return { availability, verdict, at: Date.now() };
}

/** Cached readiness. Never throws. */
export async function harnessReadiness(
  provider: HarnessProvider = activeHarness(),
  opts: { force?: boolean } = {},
): Promise<Readiness> {
  const id = provider.identity.id;
  const cached = readiness.get(id);
  const ttl = cached?.availability.ok === true ? OK_TTL_MS : BAD_TTL_MS;
  if (cached !== undefined && opts.force !== true && Date.now() - cached.at < ttl) return cached;
  const fresh = await checkReadiness(provider);
  readiness.set(id, fresh);
  return fresh;
}

/**
 * The single gate in front of every run. Throws a HarnessUnavailableError carrying the
 * harness's OWN plain-English message and fix command, so no user is ever told to run
 * another product's login command.
 */
export async function ensureHarnessReady(
  provider: HarnessProvider = activeHarness(),
): Promise<void> {
  const { availability } = await harnessReadiness(provider);
  if (!availability.ok) throw new HarnessUnavailableError(availability, provider.identity.label);
}

// ---------------------------------------------------------------------------
// status for GET /api/status
// ---------------------------------------------------------------------------

export interface HarnessStatus {
  id: string;
  label: string;
  blurb: string;
  /** null = not checked yet in this process. */
  available: boolean | null;
  version?: string;
  message?: string;
  hint?: string;
  command?: string;
  capabilities: {
    tools: 'no-tools' | 'read-only';
    mechanism: string;
    safetyProof: SafetyVerdict;
    resumeSession: boolean;
    forkSession: boolean;
    streaming: boolean;
    mcpInheritance: boolean;
    structuredOutput: boolean;
    billing: string;
  };
  /** Plain-English consequences of the capabilities above, for the status pane. */
  limitations: string[];
  checkedAt: string | null;
}

/** Generated from capabilities, in the same non-technical register as health.ts. */
export function limitationsFor(provider: HarnessProvider): string[] {
  const out: string[] = [];
  const c = provider.capabilities;
  const name = provider.identity.shortLabel;
  if (!c.mcpInheritance) out.push(`No calendar, email or task context — ${name} cannot read your other apps.`);
  if (!c.forkSession) out.push(`Each chat starts from the thread and its summary — ${name} cannot pick up the reasoning behind the rating.`);
  if (!c.streaming) out.push(`Replies appear all at once when they are ready, rather than word by word.`);
  if (c.billing === 'api-key') out.push(`${name} charges your own AI account for every message it reviews.`);
  return out;
}

export function harnessStatus(provider: HarnessProvider = activeHarness()): HarnessStatus {
  const cached = readiness.get(provider.identity.id);
  const tools = provider.capabilities.tools;
  const proof = safetyResult(provider.identity.id);
  return {
    id: provider.identity.id,
    label: provider.identity.label,
    blurb: provider.identity.blurb,
    available: cached === undefined ? null : cached.availability.ok,
    version: cached?.availability.version,
    message: cached?.availability.message,
    hint: cached?.availability.hint,
    command: cached?.availability.command,
    capabilities: {
      tools: tools.mode,
      mechanism: tools.mechanism,
      safetyProof: proof?.verdict ?? 'unverified',
      resumeSession: provider.capabilities.resumeSession,
      forkSession: provider.capabilities.forkSession,
      streaming: provider.capabilities.streaming,
      mcpInheritance: provider.capabilities.mcpInheritance,
      structuredOutput: provider.capabilities.structuredOutput,
      billing: provider.capabilities.billing,
    },
    limitations: limitationsFor(provider),
    checkedAt: cached === undefined ? null : new Date(cached.at).toISOString(),
  };
}

/**
 * Boot preflight. Resolves the configured harness (throwing on an unknown id, before the
 * server listens) and takes a first readiness reading, which never throws.
 */
export async function preflightHarness(): Promise<HarnessStatus> {
  const provider = activeHarness();
  const { availability, verdict } = await harnessReadiness(provider, { force: true });
  const version = availability.version === undefined ? '' : ` ${availability.version}`;
  if (availability.ok) {
    console.log(
      `[harness] ${provider.identity.label}${version} ready — tools: ${provider.capabilities.tools.mode}, safety proof: ${verdict}`,
    );
  } else {
    console.warn(
      `[harness] ${provider.identity.label} is not ready: ${availability.message ?? 'unavailable'}` +
        (availability.command !== undefined ? ` — fix: ${availability.command}` : ''),
    );
  }
  return harnessStatus(provider);
}

// ---------------------------------------------------------------------------
// session planning
// ---------------------------------------------------------------------------

/**
 * Which session strategy a chat turn uses, given what the harness can do.
 *
 * Note what is deliberately NOT here: resuming the analyzer's session when fork is
 * unavailable. Appending chat turns to the analyzer's transcript would poison the seed
 * that every future fresh chat starts from. Without fork, we seed.
 */
export function planSession(
  provider: HarnessProvider,
  ourSessionId: string | null,
  analyzerSessionId: string | null,
): SessionPlan {
  if (ourSessionId !== null && provider.capabilities.resumeSession) {
    return { mode: 'resume', id: ourSessionId };
  }
  if (analyzerSessionId !== null && provider.capabilities.forkSession) {
    return { mode: 'fork', id: analyzerSessionId };
  }
  return { mode: 'seed', id: null };
}

export { sanitizeEnv } from './env.js';
export { resolveToolAccess, isToolAllowed, DISALLOWED_BUILTIN_TOOLS } from './policy.js';
export { extractJsonObject } from './json.js';
export { copyFor } from './copy.js';
export * from './types.js';
