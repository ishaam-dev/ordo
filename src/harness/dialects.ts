/**
 * Event dialects — how one harness's JSONL becomes our `HarnessEvent` union.
 *
 * This is data, not code: a harness whose headless output resembles any of these is a
 * preset entry rather than an adapter (docs/harness-providers.md §8.2). The path syntax
 * is deliberately tiny:
 *
 *   'a.b.c'                  plain lookup
 *   'items[-1].text'         last element of an array
 *   'content[].text'         every element of an array, string parts concatenated
 *   '!isError'               boolean negation
 *
 * `text` is the floor: a harness with no machine-readable output still works — core
 * buffers stdout and emits one message plus one result at exit. Streaming is lost; the
 * SSE contract is not, so `streaming: false` changes no code in src/chat.ts.
 */

export type Match = Readonly<Record<string, unknown>>;

export interface DialectSpec {
  readonly session?: { readonly when: Match; readonly id: string };
  readonly text?: { readonly when: Match; readonly delta: string; readonly only?: Match };
  readonly message?: { readonly when: Match; readonly text: string };
  readonly toolStart?: { readonly when: Match; readonly name: string };
  readonly toolEnd?: { readonly when: Match; readonly name: string; readonly ok?: string };
  readonly result?: {
    readonly when: Match;
    readonly text: string;
    readonly costUsd?: string;
    readonly inputTokens?: string;
    readonly outputTokens?: string;
  };
}

/** Walk one of the tiny paths above. Returns undefined for anything that does not fit. */
export function readPath(value: unknown, path: string): unknown {
  if (path.startsWith('!')) {
    const inner = readPath(value, path.slice(1));
    return inner === undefined ? undefined : !inner;
  }
  return walk(value, path.split('.'));
}

function walk(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  const [segment, ...rest] = segments;
  const parsed = /^([^[\]]*)(?:\[(-?\d*)\])?$/.exec(segment);
  if (parsed === null) return undefined;
  const [, key, index] = parsed;

  let current: unknown = value;
  if (key !== '') {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (index === undefined) return walk(current, rest);
  if (!Array.isArray(current)) return undefined;

  if (index === '') {
    // Collect: every element contributes its string, concatenated in order.
    const parts: string[] = [];
    for (const element of current) {
      const piece = walk(element, rest);
      if (typeof piece === 'string') parts.push(piece);
    }
    return parts.join('');
  }
  const i = Number(index);
  return walk(i < 0 ? current[current.length + i] : current[i], rest);
}

export function matches(value: unknown, match: Match): boolean {
  for (const [path, expected] of Object.entries(match)) {
    if (readPath(value, path) !== expected) return false;
  }
  return true;
}

export function readString(value: unknown, path: string): string | null {
  const found = readPath(value, path);
  return typeof found === 'string' ? found : null;
}

export function readNumber(value: unknown, path: string | undefined): number | null {
  if (path === undefined) return null;
  const found = readPath(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

/**
 * The dialect table. Add a harness by adding a row — no logic anywhere else changes.
 *
 * 'pi-json'  verified against pi.dev's packages/coding-agent/docs/json.md
 * 'codex-jsonl' written from Codex's docs, NOT from captured bytes: the codex preset
 *            deliberately ships on 'text' until someone runs the experiment in
 *            docs/harness-providers.md §11.1 and pins these paths against a fixture.
 * 'text'     no JSONL at all: buffer stdout, emit one message + one result at exit.
 */
export const EVENT_DIALECTS = {
  'pi-json': {
    session: { when: { type: 'session' }, id: 'id' },
    text: {
      when: { type: 'message_update' },
      delta: 'assistantMessageEvent.delta',
      only: { 'assistantMessageEvent.type': 'text_delta' },
    },
    message: { when: { type: 'message_end' }, text: 'message.content[].text' },
    toolStart: { when: { type: 'tool_execution_start' }, name: 'toolName' },
    toolEnd: { when: { type: 'tool_execution_end' }, name: 'toolName', ok: '!isError' },
    result: { when: { type: 'agent_end' }, text: 'messages[-1].content[].text' },
  },
  'codex-jsonl': {
    session: { when: { type: 'thread.started' }, id: 'thread_id' },
    message: { when: { type: 'item.completed' }, text: 'item.text' },
    result: { when: { type: 'turn.completed' }, text: 'items[-1].text' },
  },
  'claude-stream-json': {
    session: { when: { type: 'system', subtype: 'init' }, id: 'session_id' },
    text: {
      when: { type: 'stream_event' },
      delta: 'event.delta.text',
      only: { 'event.delta.type': 'text_delta' },
    },
    message: { when: { type: 'assistant' }, text: 'message.content[].text' },
    result: {
      when: { type: 'result', subtype: 'success' },
      text: 'result',
      costUsd: 'total_cost_usd',
    },
  },
  text: {},
} as const satisfies Record<string, DialectSpec>;

export type DialectName = keyof typeof EVENT_DIALECTS;
