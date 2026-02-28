import { type Transformer } from "../operations/transform.ts";

export interface JsonOptions<T = unknown, R = unknown, V = unknown> {
  /**
   * Dot-notation path to extract from the parsed JSON, e.g. "data.items[0].name".
   * If omitted, the full parsed JSON is returned.
   */
  path?: string;
  /** Pluck JSON string from body. If omitted: body is used when it's a string, or body.body when body is an object (e.g. after http()). */
  from?: (body: T) => string;
  /**
   * Extract or transform the parsed value; return type V is inferred and used for result (and for to(body, result)).
   * When omitted, parsed/path result is used as-is and typed as unknown.
   */
  getValue?: (parsed: unknown) => V;
  /** Where to put the parsed/extracted result. If omitted, result replaces the entire body (same default as from). Use e.g. (body, result) => ({ ...body, parsed: result }) to write to a sub-field. Result is typed as V when getValue is provided. */
  to?: (body: T, result: V) => R;
}

function getText<T>(body: T, from: ((body: T) => string) | undefined): string {
  if (from) return from(body);
  if (typeof body === "string") return body;
  if (
    body &&
    typeof body === "object" &&
    "body" in body &&
    typeof (body as { body: unknown }).body === "string"
  ) {
    return (body as { body: string }).body;
  }
  throw new Error(
    "json adapter: body must be a string, an object with a string body property (e.g. http() result), or provide a from() option",
  );
}

/**
 * Get a value from an object by dot path with optional [index] for arrays.
 * e.g. "data.items[0].name" -> obj.data.items[0].name
 */
function getByPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return obj;
  const segments = trimmed.split(".").filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    const bracket = seg.indexOf("[");
    if (bracket === -1) {
      current = (current as Record<string, unknown>)[seg];
      continue;
    }
    const key = seg.slice(0, bracket);
    const indexMatch = seg.slice(bracket).match(/^\[(\d+)\]$/);
    if (key) {
      current = (current as Record<string, unknown>)[key];
    }
    if (indexMatch) {
      const index = Number(indexMatch[1]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
}

export class JsonAdapter<
  T = unknown,
  R = unknown,
  V = unknown,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.json";

  constructor(private readonly options: JsonOptions<T, R, V>) {}

  transform(body: T): R {
    const text = getText(body, this.options.from);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`json adapter: failed to parse JSON: ${message}`);
    }
    const path = this.options.path?.trim();
    const pathResult = path ? getByPath(parsed, path) : parsed;
    const result = this.options.getValue
      ? this.options.getValue(pathResult)
      : pathResult;

    const to = this.options.to;
    if (to) return to(body, result as V) as R;
    return result as unknown as R;
  }
}

/**
 * Creates a JSON transformer: parses a JSON string and optionally extracts a value by path.
 * By default uses body (or body.body when object) as the JSON string and replaces the body with the result. Use `path` for dot-notation extraction, `getValue(parsed)` to extract and type the value, `from`/`to` to read/write sub-fields.
 *
 * @param options - Optional `path`, `from(body)`, `getValue(parsed)`, `to(body, result)`
 * @returns A Transformer; when `getValue` is provided and `to` is omitted, output type is inferred from getValue
 *
 * @example
 * ```typescript
 * .transform(json({ path: 'data.items' }))
 * .transform(json({ from: (b) => b.raw, getValue: (p) => p as User[], to: (b, users) => ({ ...b, users }) }))
 * ```
 */
export function json<T, R, V>(
  options: JsonOptions<T, R, V> & {
    getValue: (parsed: unknown) => V;
    to?: undefined;
  },
): Transformer<T, V>;
export function json<T = unknown, R = unknown, V = unknown>(
  options?: JsonOptions<T, R, V>,
): Transformer<T, R>;
export function json<T = unknown, R = unknown, V = unknown>(
  options: JsonOptions<T, R, V> = {},
): Transformer<T, R> | Transformer<T, V> {
  return new JsonAdapter<T, R, V>(options) as unknown as
    | Transformer<T, R>
    | Transformer<T, V>;
}
