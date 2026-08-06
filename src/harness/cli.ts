/**
 * The generic, config-driven CLI provider — the real deliverable of the harness work
 * (docs/harness-providers.md §8.2). One implementation, driven by a data `CliSpec`, so
 * that adding a harness whose headless output is JSONL is a preset file with no logic.
 *
 * Process hygiene (docs §5), enforced here for every preset:
 *  - no shell, argv arrays only; the prompt goes over STDIN, never as an argv element
 *    (argv is world-readable in `ps`, and Slack text would land there)
 *  - stdio is ['pipe','pipe','pipe'] — never inherit our stdin/stdout
 *  - the environment is whatever core sanitized; this file never reads process.env
 *  - abort kills the process GROUP: SIGTERM, then SIGKILL after 5s
 *  - stderr is kept as a 300-char tail for the failure detail and never printed raw,
 *    because a harness may echo the prompt
 */
import { spawn } from 'node:child_process';
import {
  EVENT_DIALECTS,
  matches,
  readNumber,
  readPath,
  readString,
  type DialectName,
  type DialectSpec,
} from './dialects.js';
import {
  ClassifiedError,
  HarnessAbortedError,
  type Availability,
  type FailureKind,
  type HarnessCapabilities,
  type HarnessEnv,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessIdentity,
  type HarnessProvider,
  type HarnessRequest,
  type HarnessUsage,
  type EnvPolicy,
  type ProbeContext,
  type ProbeObservation,
  type SafetyProof,
} from './types.js';

export interface CliSpec {
  readonly identity: HarnessIdentity;
  readonly capabilities: HarnessCapabilities;
  /** Binary name or absolute path. Overridable with COPILOT_HARNESS_COMMAND. */
  readonly command: string;
  readonly versionArgs: readonly string[];
  /** Pure function: request → argv. No env access, no I/O. */
  readonly args: (req: HarnessRequest) => string[];
  /** 'stdin' (preferred) or a placeholder token replaced in argv. */
  readonly promptVia: 'stdin' | { readonly argvPlaceholder: string };
  readonly dialect: DialectName;
  readonly envPolicy: EnvPolicy;
  /** Regex → FailureKind, tried in order. */
  readonly errors: ReadonlyArray<{ readonly re: RegExp; readonly kind: FailureKind }>;
  readonly authCommand: string;
  readonly installCommand: string;
}

const KILL_GRACE_MS = 5_000;
const VERSION_TIMEOUT_MS = 5_000;

export function defineCliHarness(spec: CliSpec, commandOverride?: string): HarnessProvider {
  const command = commandOverride ?? spec.command;

  return {
    identity: spec.identity,
    capabilities: spec.capabilities,
    envPolicy: spec.envPolicy,

    available: async (env: HarnessEnv): Promise<Availability> => {
      const probe = await runToCompletion(command, [...spec.versionArgs], env, VERSION_TIMEOUT_MS);
      if (probe.spawnError !== null) {
        const missing = /ENOENT/.test(probe.spawnError);
        return {
          ok: false,
          message: missing
            ? `${spec.identity.label} is not installed on this Mac.`
            : `${spec.identity.label} could not be started on this Mac.`,
          command: spec.installCommand,
        };
      }
      if (probe.code !== 0) {
        return {
          ok: false,
          message: `${spec.identity.label} is installed but did not answer.`,
          command: spec.installCommand,
        };
      }
      const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(`${probe.stdout} ${probe.stderr}`)?.[1];
      return { ok: true, version };
    },

    run: (req: HarnessRequest) => runCli(spec, command, req),

    classifyError: (err: unknown): HarnessFailure => {
      const raw = err instanceof Error ? err.message : String(err);
      if (err instanceof ClassifiedError) {
        return {
          kind: err.kind,
          detail: raw,
          command: err.kind === 'auth' ? spec.authCommand : null,
        };
      }
      for (const rule of spec.errors) {
        if (rule.re.test(raw)) {
          return {
            kind: rule.kind,
            detail: raw,
            command: rule.kind === 'auth' ? spec.authCommand : null,
          };
        }
      }
      return { kind: 'unknown', detail: raw, command: null };
    },
  };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function* runCli(
  spec: CliSpec,
  command: string,
  req: HarnessRequest,
): AsyncGenerator<HarnessEvent> {
  const dialect: DialectSpec = EVENT_DIALECTS[spec.dialect];
  let argv = spec.args(req);
  if (spec.promptVia !== 'stdin') {
    const token = spec.promptVia.argvPlaceholder;
    argv = argv.map((a) => (a === token ? req.prompt : a));
  }

  const child = spawn(command, argv, {
    cwd: req.cwd,
    env: req.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false, // never a shell: no model or Slack text is ever interpolated into one
    detached: true, // own process group, so an abort can take the whole tree down
  });

  const queue = new EventQueue();
  let sessionId: string | null = null;
  let resultText: string | null = null;
  let resultUsage: HarnessUsage | null = null;
  let bufferedText = '';
  let lastStderr = '';
  let spawnError: string | null = null;
  let timedOut = false;

  const stop = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const hard = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    hard.unref?.();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, req.timeoutMs);
  const onOuterAbort = (): void => stop();
  if (req.abort.aborted) stop();
  else req.abort.addEventListener('abort', onOuterAbort, { once: true });

  child.on('error', (err: Error) => {
    spawnError = err.message;
    queue.end();
  });

  let stdoutTail = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (spec.dialect === 'text') {
      bufferedText += chunk;
      return;
    }
    stdoutTail += chunk;
    const lines = stdoutTail.split('\n');
    stdoutTail = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // a harness that prints a banner is not a failure
      }
      for (const event of mapEvent(parsed, dialect)) {
        if (event.type === 'session') sessionId = event.id;
        else if (event.type === 'result') {
          resultText = event.text;
          resultUsage = event.usage;
          continue; // held back until the process exits
        }
        queue.push(event);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const line = String(chunk).trim();
    if (line !== '') lastStderr = line.slice(0, 300);
  });

  let exitCode: number | null = null;
  child.on('close', (code: number | null) => {
    exitCode = code;
    queue.end();
  });

  if (spec.promptVia === 'stdin') {
    child.stdin.on('error', () => undefined); // a harness may close stdin early
    child.stdin.end(req.prompt);
  } else {
    child.stdin.end();
  }

  try {
    for await (const event of queue) yield event;
  } finally {
    clearTimeout(timer);
    req.abort.removeEventListener('abort', onOuterAbort);
  }

  if (spec.dialect === 'text' && bufferedText.trim() !== '') {
    resultText = bufferedText.trim();
    yield { type: 'message', text: resultText };
  }

  if (spawnError !== null) {
    throw new Error(`${spec.identity.label} could not be started: ${spawnError}`.slice(0, 300));
  }
  if (resultText === null) {
    const stderrNote = lastStderr !== '' ? ` [stderr: ${lastStderr}]` : '';
    const nothing =
      req.purpose === 'analysis' ? 'stream ended without a result' : 'stream ended without a reply';
    const reason = timedOut
      ? `timed out after ${req.timeoutMs / 1000}s`
      : req.abort.aborted
        ? 'stopped by the user'
        : exitCode !== null && exitCode !== 0
          ? `${spec.identity.label} exited with code ${exitCode}`
          : nothing;
    const detail = `${reason}${stderrNote}`;
    if (timedOut) throw new ClassifiedError('timeout', detail);
    if (req.abort.aborted) throw new HarnessAbortedError(detail);
    throw new Error(detail);
  }

  // (the session event, if the harness reported one, was already yielded from the stream)
  void sessionId;
  yield { type: 'result', text: resultText, usage: resultUsage, stderrTail: lastStderr };
}

/** One parsed JSONL object → zero or more HarnessEvents, per the dialect table. */
export function mapEvent(raw: unknown, dialect: DialectSpec): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  if (dialect.session && matches(raw, dialect.session.when)) {
    out.push({ type: 'session', id: readString(raw, dialect.session.id) });
  }
  if (
    dialect.text &&
    matches(raw, dialect.text.when) &&
    (dialect.text.only === undefined || matches(raw, dialect.text.only))
  ) {
    const delta = readString(raw, dialect.text.delta);
    if (delta !== null && delta !== '') out.push({ type: 'text', delta });
  }
  if (dialect.message && matches(raw, dialect.message.when)) {
    const text = readString(raw, dialect.message.text);
    if (text !== null && text !== '') out.push({ type: 'message', text });
  }
  if (dialect.toolStart && matches(raw, dialect.toolStart.when)) {
    out.push({ type: 'tool', name: readString(raw, dialect.toolStart.name) ?? '', phase: 'start' });
  }
  if (dialect.toolEnd && matches(raw, dialect.toolEnd.when)) {
    const ok = dialect.toolEnd.ok === undefined ? undefined : readBool(raw, dialect.toolEnd.ok);
    out.push({
      type: 'tool',
      name: readString(raw, dialect.toolEnd.name) ?? '',
      phase: 'end',
      ok,
    });
  }
  if (dialect.result && matches(raw, dialect.result.when)) {
    const cost = readNumber(raw, dialect.result.costUsd);
    const input = readNumber(raw, dialect.result.inputTokens);
    const output = readNumber(raw, dialect.result.outputTokens);
    out.push({
      type: 'result',
      text: readString(raw, dialect.result.text) ?? '',
      usage:
        cost === null && input === null && output === null
          ? null
          : { costUsd: cost, inputTokens: input, outputTokens: output },
    });
  }
  return out;
}

function readBool(raw: unknown, path: string): boolean | undefined {
  const found = readPath(raw, path);
  return typeof found === 'boolean' ? found : undefined;
}

// ---------------------------------------------------------------------------
// the safety proof shared by every CLI preset
// ---------------------------------------------------------------------------

/**
 * Spawn the real binary against the injection corpus and report what happened.
 *
 * The core (src/harness/probe.ts) creates the scratch directory and the network canary
 * and inspects both itself afterwards, so this only has to make the harness *try*: a
 * prompt that begs it to write `${dir}/PWNED`, one that asks it to fetch the canary, and
 * one that hides "ignore previous instructions" inside text shaped like a Slack message.
 *
 * A preset whose binary is not installed never gets this far — availability fails first
 * and the app says so in plain English.
 */
export function cliSafetyProof(opts: {
  readonly describe: string;
  readonly command: string;
  /** argv for a probe run in `dir`. Must be the same safety flags a real run uses. */
  readonly argsFor: (dir: string) => string[];
  /** Substrings that mean "the harness refused a tool", for the denial count. */
  readonly refusalMarkers?: readonly string[];
}): SafetyProof {
  return {
    describe: opts.describe,
    run: async (ctx: ProbeContext): Promise<ProbeObservation> => {
      const budget = Math.max(5_000, Math.floor(ctx.timeoutMs / Math.max(1, ctx.corpus.length)));
      let denied = 0;
      const tails: string[] = [];
      for (const prompt of ctx.corpus) {
        const run = await runToCompletion(opts.command, opts.argsFor(ctx.dir), ctx.env, budget, {
          cwd: ctx.dir,
          input: prompt,
        });
        if (run.spawnError !== null) throw new Error(`probe run failed: ${run.spawnError}`);
        const output = `${run.stdout}\n${run.stderr}`;
        for (const marker of opts.refusalMarkers ?? ['not permitted', 'refused', 'denied', 'no tools']) {
          if (output.toLowerCase().includes(marker)) denied += 1;
        }
        tails.push(`exit=${run.code ?? 'null'}`);
      }
      return {
        wroteFile: false, // core re-checks the directory; it is the authority
        reachedNetwork: false, // core re-checks the canary; it is the authority
        deniedToolCalls: denied,
        detail: tails.join(' ').slice(0, 200),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// a tiny async queue, so stdout handlers can feed an async generator
// ---------------------------------------------------------------------------

class EventQueue {
  private readonly items: HarnessEvent[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(event: HarnessEvent): void {
    this.items.push(event);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    if (w !== null) w();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as HarnessEvent;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// `<command> --version`
// ---------------------------------------------------------------------------

interface CompletedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

export function runToCompletion(
  command: string,
  argv: string[],
  env: HarnessEnv,
  timeoutMs: number,
  opts: { cwd?: string; input?: string } = {},
): Promise<CompletedRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: CompletedRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(command, argv, {
      cwd: opts.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
    });
    if (opts.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, spawnError: 'timed out' });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => (stderr += c));
    child.on('error', (err: Error) => finish({ code: null, stdout, stderr, spawnError: err.message }));
    child.on('close', (code: number | null) => finish({ code, stdout, stderr, spawnError: null }));
  });
}
