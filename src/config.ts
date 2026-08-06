import 'dotenv/config';
import { harnessConfigFromEnv } from './harness/env.js';

export interface Workspace {
  key: string;
  userToken: string;
  appToken: string;
}

/** A token counts as configured only if it is non-empty and not an obvious placeholder. */
export function tokenIfValid(value: string | undefined, prefix: string): string | null {
  const v = (value ?? '').trim();
  if (v === '') return null;
  if (v.includes('...')) return null; // placeholder like "xoxp-..."
  if (!v.startsWith(prefix)) return null;
  return v;
}

export function loadWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const key of ['A', 'B']) {
    const userRaw = process.env[`SLACK_${key}_USER_TOKEN`];
    const appRaw = process.env[`SLACK_${key}_APP_TOKEN`];
    const userToken = tokenIfValid(userRaw, 'xoxp-');
    const appToken = tokenIfValid(appRaw, 'xapp-');
    if (userToken && appToken) {
      workspaces.push({ key, userToken, appToken });
    } else if ((userRaw ?? '').trim() !== '' || (appRaw ?? '').trim() !== '') {
      console.warn(
        `[config] workspace ${key}: tokens present but incomplete or placeholder ` +
          `(need SLACK_${key}_USER_TOKEN starting with xoxp- and SLACK_${key}_APP_TOKEN starting with xapp-) — skipping`,
      );
    }
  }
  return workspaces;
}

export const workspaces: Workspace[] = loadWorkspaces();

export const PORT: number = (() => {
  const raw = (process.env.PORT ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 5252;
})();

/**
 * How many thread analyses may run at once (`COPILOT_ANALYZER_CONCURRENCY`).
 *
 * Each analysis is a whole harness process that connects to every MCP server the user
 * has configured, so this is not a cheap knob — it is the difference between a backlog
 * draining in three minutes and in twelve. It does not matter in steady state (one
 * message, one analysis); it matters after the laptop has been shut, which is the case
 * this app exists for.
 *
 * MEASURED, not guessed: a backlog of 8 real threads drained end to end through the real
 * harness on this Mac, twice, on a throwaway database (16 threads pooled per level):
 *
 *   N=1  229.3s  1.00x  1.00 per worker
 *   N=2  115.1s  1.99x  1.00
 *   N=3   90.8s  2.53x  0.84
 *   N=4   71.5s  3.21x  0.80
 *   N=6   57.1s  4.02x  0.67   ← the elbow: half again as many processes, a quarter less time
 *   N=8   25.5s  5.11x  0.64   (one replicate)
 *
 * The slowest run in a batch also stretches with N (median ~14s, but 33s at N=4), which
 * matters because every analysis is racing a 180s timeout. So: ceiling 4, past which the
 * marginal gain per added process has clearly collapsed; default 3, which takes ~79% of
 * the ceiling's win while leaving the laptop room for the app the user is actually
 * looking at. Anyone who wants the ceiling can ask for it.
 */
export const MAX_ANALYZER_CONCURRENCY = 4;
const DEFAULT_ANALYZER_CONCURRENCY = 3;

/**
 * Parse and CLAMP. Anything unparseable falls back to the default (as PORT does); a
 * number above the ceiling is clamped rather than rejected, because "16" is a legible
 * intent that must simply not be honoured — sixteen simultaneous harness processes,
 * each with its own MCP fleet, is not a state this app may reach.
 */
export function analyzerConcurrencyFrom(value: string | undefined): number {
  const raw = (value ?? '').trim();
  if (raw === '') return DEFAULT_ANALYZER_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ANALYZER_CONCURRENCY;
  return Math.min(n, MAX_ANALYZER_CONCURRENCY);
}

export const ANALYZER_CONCURRENCY: number = (() => {
  const raw = (process.env.COPILOT_ANALYZER_CONCURRENCY ?? '').trim();
  const value = analyzerConcurrencyFrom(raw);
  if (raw !== '' && Number(raw) > MAX_ANALYZER_CONCURRENCY) {
    console.warn(
      `[config] COPILOT_ANALYZER_CONCURRENCY=${raw} is above the ceiling of ` +
        `${MAX_ANALYZER_CONCURRENCY} — using ${value}`,
    );
  }
  return value;
})();

/**
 * Which AI harness runs the analysis and the chat. Defaults to 'claude-code', so an
 * existing install behaves exactly as it did. An unknown value is fatal at boot (see
 * src/harness/index.ts selectHarness) rather than silently falling back — that would
 * bill the wrong account and hide the typo. The values are parsed in
 * src/harness/env.ts, the one file allowed to read process.env inside the harness layer.
 */
const harness = harnessConfigFromEnv();
export const HARNESS_ID: string = harness.id;
export const HARNESS_COMMAND: string | null = harness.command;
export const HARNESS_MODEL: string | null = harness.model;
export const HARNESS_SPEND_OK: boolean = harness.spendOk;
