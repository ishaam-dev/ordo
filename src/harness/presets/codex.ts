/**
 * Codex — data only. No logic lives here; src/harness/cli.ts runs it.
 *
 * Flags verified against the Codex docs:
 *   codex exec "<task>"      non-interactive; prints only the final message to stdout
 *   -                        read the prompt from stdin
 *   --sandbox read-only      OS sandbox: filesystem writes AND network egress blocked
 *                            (workspace-write / danger-full-access are opt-in; we never
 *                            pass them)
 *   --ignore-user-config     ignore ~/.codex config, which also neutralises the
 *                            MCP-config code-execution advisory (GHSA-xrxf-jgv3-qmrm)
 *   -c features.web_search=false   repeatable -c overrides beat any config file; web
 *                            search is itself a documented prompt-injection surface
 *   --skip-git-repo-check    we run in an empty scratch directory, not a repo
 *   --ephemeral              do not persist a rollout for a background analysis
 *   --json                   JSONL (thread.started / item.* / turn.completed)
 *
 * THE HONEST PROBLEM, AND THE CALL. Codex has no `--no-tools` and no per-call hook we can
 * wire in `exec` mode, so it can satisfy neither our core gate nor a literal "tools off"
 * switch. What it does have is an OS sandbox that, in read-only, blocks writes and the
 * network. Under our rule containment is enough to *prevent side effects* — but it still
 * lets the model read the filesystem, and Codex has a critical MCP advisory
 * (GHSA-xrxf-jgv3-qmrm) and a high sandbox path-logic bypass (GHSA-w5fx-fh39-j5rw). So it
 * ships as `no-tools` with containment as the mechanism, and it earns that claim only by
 * passing the proof on the user's actual machine: no file in the scratch directory, no
 * canary hit, nothing observable from an injected instruction. If the proof fails, codex
 * is unavailable and the app says so — exactly what we want the day a bypass ships.
 *
 * DIALECT: 'text', deliberately. The `item.*` event family in docs/harness-providers.md
 * §11.1 was written from documentation, not from captured bytes. Until someone runs that
 * experiment and pins the paths against a fixture, this preset takes the final message
 * only — correct if unlovely — and therefore also declares no session support, because
 * the thread id is only observable on the JSONL path. Flipping both on is a two-line
 * change here plus the already-present 'codex-jsonl' row in dialects.ts.
 */
import { cliSafetyProof, type CliSpec } from '../cli.js';

const COMMAND = 'codex';

/** The flags that make a run contained. Used by real runs AND by the safety proof. */
const SAFE_FLAGS = [
  '--sandbox',
  'read-only',
  '--ignore-user-config',
  '-c',
  'features.web_search=false',
  '--skip-git-repo-check',
];

export const CODEX: CliSpec = {
  identity: {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    blurb: 'runs on your own OpenAI account',
  },
  command: COMMAND,
  versionArgs: ['--version'],
  promptVia: 'stdin',
  dialect: 'text',
  args: (req) => [
    'exec',
    ...SAFE_FLAGS,
    ...(req.purpose === 'analysis' ? ['--ephemeral'] : []),
    ...(req.model !== undefined ? ['--model', req.model] : []),
    '-', // prompt on stdin, never in argv
  ],
  capabilities: {
    tools: {
      mode: 'no-tools',
      mechanism:
        '--sandbox read-only (writes and network blocked by the OS) + --ignore-user-config + no approval TTY + an empty working directory',
      proof: cliSafetyProof({
        describe: 'codex exec --sandbox read-only writes no file and reaches no network',
        command: COMMAND,
        argsFor: () => ['exec', ...SAFE_FLAGS, '--ephemeral', '-'],
      }),
    },
    resumeSession: false, // see DIALECT above: no thread id without the JSONL path
    forkSession: false, // Codex resumes but never forks
    streaming: false,
    mcpInheritance: false,
    structuredOutput: true, // --output-schema exists; core parses the text either way
    billing: 'api-key',
  },
  envPolicy: {
    mode: 'allowlist',
    deny: ['CODEX_'],
    allow: ['OPENAI_API_KEY'],
  },
  errors: [
    { re: /not logged in|login|unauthorized|401|invalid api key|no api key/i, kind: 'auth' },
    { re: /quota|billing|credit|usage limit|insufficient/i, kind: 'budget' },
    { re: /rate.?limit|too many requests|\b429\b|overloaded/i, kind: 'rate_limit' },
    { re: /timed? ?out|timeout|etimedout|deadline exceeded/i, kind: 'timeout' },
  ],
  authCommand: 'codex login',
  installCommand: 'npm install -g @openai/codex',
};
