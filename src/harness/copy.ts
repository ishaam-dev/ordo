/**
 * The plain-English failure copy, moved out of src/health.ts so that the tone stays
 * centralised while the *classification* becomes per-harness.
 *
 * Every string here is shown verbatim to a non-technical reader: no "OAuth", "SDK",
 * "token", "daemon", "stderr", "subprocess". The only variable parts are the harness's
 * own short name ("Claude", "Pi", "Codex") and its own fix command — which is the whole
 * point: a Codex user must never be told to run `claude auth login`.
 *
 * With the default harness (shortLabel "Claude", command "claude auth login") every
 * string below is byte-identical to what src/health.ts hard-coded before.
 */
import type { FailureKind } from './types.js';

export interface CopyContext {
  /** The harness's name inside a sentence: "Claude", "Pi", "Codex". */
  readonly name: string;
  /** The harness's own fix command, when a command is the fix. */
  readonly command: string | null;
}

export interface Copy {
  readonly message: string;
  readonly hint: string;
}

export function copyFor(kind: FailureKind, ctx: CopyContext): Copy {
  const n = ctx.name;
  switch (kind) {
    case 'auth':
      return {
        message: `${n} isn't signed in on this Mac`,
        hint:
          ctx.command !== null
            ? `Open Terminal and run: ${ctx.command}`
            : `Sign in to ${n} on this Mac, then come back here.`,
      };
    case 'timeout':
      return {
        message: `${n} took too long to review a message`,
        hint: 'It will try again on its own in a few minutes. If every message stalls, quit and reopen the app.',
      };
    case 'rate_limit':
      return {
        message: `${n} is temporarily busy and asked us to slow down`,
        hint: 'This usually clears by itself within a few minutes. Nothing for you to do.',
      };
    case 'budget':
      return {
        message: `${n}'s usage limit for this plan has been reached`,
        hint: `Prioritizing starts again when the limit resets, or on a higher ${n} plan.`,
      };
    case 'bad_output':
      return {
        message: `${n}'s answer came back in a form this app could not read`,
        hint: 'Usually a one-off. It retries in a few minutes, or press Re-analyze on the message.',
      };
    default:
      return {
        message: `${n} couldn't review this message`,
        hint: 'It will try again in a few minutes. If it keeps happening, quit and reopen the app.',
      };
  }
}
