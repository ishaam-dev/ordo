/**
 * Child-process environment hygiene — docs/harness-providers.md §5.
 *
 * THIS IS THE ONLY FILE UNDER src/harness/ ALLOWED TO READ process.env.
 * test/harness-boundaries.test.ts greps for violations, because an adapter that spawns
 * with the parent environment hands a real Slack user token to a model subprocess.
 *
 * Two families are dropped for every harness, whatever it declares:
 *  - SLACK_*: real user tokens from .env must never reach a model subprocess.
 *  - the selected harness's own nested-session markers: for Claude Code that is CLAUDE*
 *    and ANTHROPIC_BASE_URL, because this server is often launched from inside a Claude
 *    Code session and the child then defers auth to a host session that isn't there
 *    ("OAuth session expired and could not be refreshed"). Stripping them makes the run
 *    authenticate via the machine's own login, exactly like a fresh launch from a clean
 *    terminal.
 *
 * Deny lists are per-provider on purpose: Pi authenticates with ANTHROPIC_API_KEY, which
 * the Claude adapter's list would happily destroy if one global regex were used.
 */
import type { EnvPolicy, HarnessEnv, HarnessProvider } from './types.js';

/** Non-negotiable, non-overridable, applied last so no provider can re-admit it. */
const GLOBAL_DENY_PREFIXES = ['SLACK_'] as const;

/**
 * The harness switches, read here because this is the file allowed to touch process.env.
 * src/config.ts re-exports them next to PORT; src/harness/index.ts consumes them.
 */
export interface HarnessConfig {
  /** COPILOT_HARNESS. Default 'claude-code', so an existing install is unchanged. */
  readonly id: string;
  /** COPILOT_HARNESS_COMMAND — absolute path to the binary, for CLI harnesses. */
  readonly command: string | null;
  /** COPILOT_HARNESS_MODEL — passed through to the harness. */
  readonly model: string | null;
  /** COPILOT_HARNESS_SPEND_OK=1 — lets a per-token harness run the background analyzer. */
  readonly spendOk: boolean;
}

export const DEFAULT_HARNESS_ID = 'claude-code';

export function harnessConfigFromEnv(base: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const raw = (base.COPILOT_HARNESS ?? '').trim().toLowerCase();
  const command = (base.COPILOT_HARNESS_COMMAND ?? '').trim();
  const model = (base.COPILOT_HARNESS_MODEL ?? '').trim();
  return {
    id: raw === '' ? DEFAULT_HARNESS_ID : raw,
    command: command === '' ? null : command,
    model: model === '' ? null : model,
    spendOk: (base.COPILOT_HARNESS_SPEND_OK ?? '') === '1',
  };
}

/** Kept for an 'allowlist' harness: enough to find a binary, a home and a terminal. */
const BASE_ALLOW = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
  'TZ',
  'USER',
  'LOGNAME',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

function denied(key: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/**
 * Build the environment for one harness's child process.
 *
 * `mode: 'inherit'` is what Claude Code has always done (the user's own MCP servers are
 * spawned by that child and need their keys). `mode: 'allowlist'` is the tighter posture
 * new harnesses get: nothing but the base list plus what the provider declares.
 */
export function sanitizeEnv(
  provider: Pick<HarnessProvider, 'envPolicy'> | EnvPolicy,
  base: NodeJS.ProcessEnv = process.env,
): HarnessEnv {
  const policy: EnvPolicy = 'envPolicy' in provider ? provider.envPolicy : provider;
  const out: Record<string, string | undefined> = {};

  if (policy.mode === 'inherit') {
    for (const [key, value] of Object.entries(base)) {
      if (denied(key, policy.deny)) continue;
      out[key] = value;
    }
  } else {
    const allow = new Set<string>([...BASE_ALLOW, ...policy.allow]);
    for (const key of allow) {
      if (denied(key, policy.deny)) continue;
      const value = base[key];
      if (value !== undefined) out[key] = value;
    }
  }

  // Applied last, unconditionally: no provider can re-admit a Slack token.
  for (const key of Object.keys(out)) {
    if (denied(key, GLOBAL_DENY_PREFIXES)) delete out[key];
  }
  return out;
}
