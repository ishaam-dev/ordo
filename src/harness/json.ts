/**
 * The one-JSON-object output contract is OURS, not any harness's, so the extraction runs
 * in core for every provider (docs/harness-providers.md §7). Moved verbatim from
 * src/analyzer.ts — every quirk pinned by test/analyzer-contract.test.ts is intentional:
 * the scan starts at the first '{', so an array yields its first element and a brace
 * quoted in prose derails it.
 *
 * A provider with native structured output may use it; core still parses the text it got
 * back, so "malformed" means the same thing for every harness.
 */

/** Extract the first balanced {...} block (tolerates fences/prose around it) and parse it. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const t = text.trim();
  const start = t.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in result');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(t.slice(start, i + 1));
        } catch {
          throw new Error('result JSON failed to parse');
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        throw new Error('result JSON is not an object');
      }
    }
  }
  throw new Error('unbalanced JSON object in result');
}
