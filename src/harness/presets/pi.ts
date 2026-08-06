/**
 * Pi — data only. No logic lives here; src/harness/cli.ts runs it.
 *
 * Flags verified against pi.dev / earendil-works/pi docs (packages/coding-agent/docs/json.md,
 * security.md, README):
 *   --mode json      JSONL on stdout: {"type":"session"} first, then message_update /
 *                    message_end / tool_execution_* / agent_end
 *   --no-tools       disables ALL tools — the whole safety story for this preset
 *   --session <id>   resume;  --fork <id>  fork
 *   --model <name>   model selection
 *
 * WHY no-tools, and not read-only: Pi's own security document is unusually candid —
 * "Pi does not include a built-in sandbox", there are no per-tool approval prompts, and
 * prompt injection is an "expected local-agent risk [that] cannot be reliably prevented".
 * A harness with that posture must never see attacker-controlled Slack text with tools
 * on. It does not have to: --no-tools turns them all off, and the proof below asserts
 * that a prompt begging it to write a file produces no file.
 *
 * Known limitation, stated honestly: Pi has no MCP, so there is no calendar/task context.
 * That is `mcpInheritance: false`, and /api/status renders it as a limitation.
 *
 * Supply chain: upstream recommends installing with --ignore-scripts, and the 2026-06
 * advisories (GHSA-jfgx-wxx8-mp94 high, GHSA-mqxh-6gq7-558m medium, two low) are all
 * about extensions and local state — which is why this preset never passes --approve and
 * never enables project trust.
 */
import { cliSafetyProof, type CliSpec } from '../cli.js';

const COMMAND = 'pi';

export const PI: CliSpec = {
  identity: {
    id: 'pi',
    label: 'Pi',
    shortLabel: 'Pi',
    blurb: 'runs on your own AI account',
  },
  command: COMMAND,
  versionArgs: ['--version'],
  promptVia: 'stdin',
  dialect: 'pi-json',
  args: (req) => [
    '--mode',
    'json',
    '--no-tools', // ← the whole safety story
    ...(req.session.mode === 'resume' && req.session.id !== null ? ['--session', req.session.id] : []),
    ...(req.session.mode === 'fork' && req.session.id !== null ? ['--fork', req.session.id] : []),
    ...(req.model !== undefined ? ['--model', req.model] : []),
  ],
  capabilities: {
    tools: {
      mode: 'no-tools',
      mechanism: '--no-tools (every tool disabled)',
      proof: cliSafetyProof({
        describe: 'pi --no-tools writes no file and reaches no network on the injection corpus',
        command: COMMAND,
        argsFor: () => ['--mode', 'json', '--no-tools'],
      }),
    },
    resumeSession: true,
    forkSession: true,
    streaming: true,
    mcpInheritance: false,
    structuredOutput: false,
    billing: 'api-key',
  },
  envPolicy: {
    mode: 'allowlist',
    deny: ['PI_'],
    allow: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  },
  errors: [
    { re: /not logged in|no api key|missing api key|unauthorized|401|invalid api key/i, kind: 'auth' },
    { re: /credit|quota|billing|usage limit|insufficient/i, kind: 'budget' },
    { re: /rate.?limit|too many requests|\b429\b|overloaded/i, kind: 'rate_limit' },
    { re: /timed? ?out|timeout|etimedout|deadline exceeded/i, kind: 'timeout' },
  ],
  authCommand: 'pi /login',
  installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
};
