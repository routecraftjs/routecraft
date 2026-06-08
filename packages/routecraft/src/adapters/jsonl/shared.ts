/**
 * Parse a JSON Lines string into an array of values.
 *
 * Splits on newlines, skips empty lines, and `JSON.parse`s each remaining line
 * with the optional reviver. Shared by the read-as-destination mode and the
 * transformer so both decode in-memory JSONL the same way.
 *
 * @internal Not exported from the package public API.
 */
export function parseJsonl<T = unknown>(
  content: string,
  reviver?: (key: string, value: unknown) => unknown,
): T[] {
  const out: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed, reviver) as T);
  }
  return out;
}
