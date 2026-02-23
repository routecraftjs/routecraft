import { type Transformer } from "../operations/transform.ts";

export interface JsonOptions<T = unknown, R = unknown> {
  /**
   * Dot-notation path to extract from the parsed JSON, e.g. "data.items[0].name".
   * If omitted, the full parsed JSON is returned.
   */
  path?: string;
  /** Pluck JSON string from body. If omitted: body is used when it's a string, or body.body when body is an object (e.g. after http()). */
  from?: (body: T) => string;
  /** Where to put the parsed/extracted result. If omitted, result replaces the entire body (same default as from). Use e.g. (body, result) => ({ ...body, parsed: result }) to write to a sub-field. */
  to?: (body: T, result: unknown) => R;
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

export class JsonAdapter<T = unknown, R = unknown> implements Transformer<
  T,
  R
> {
  readonly adapterId = "routecraft.adapter.json";

  constructor(private readonly options: JsonOptions<T, R>) {}

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
    const result = path ? getByPath(parsed, path) : parsed;

    const to = this.options.to;
    if (to) return to(body, result) as R;
    return result as unknown as R;
  }
}

/**
 * Create a JSON transformer that parses a JSON string and optionally extracts a value by path.
 * By default uses body (or body.body when object) as the JSON string and replaces the entire body with the result. Use `from` to read a sub-field and `to` to write the result into a sub-field (default to replaces whole body, same as from).
 *
 * @param options - optional path, optional from(body) to get JSON string, optional to(body, result) to write result into body
 * @returns Transformer
 */
export function json<T = unknown, R = unknown>(
  options: JsonOptions<T, R> = {},
): Transformer<T, R> {
  return new JsonAdapter<T, R>(options);
}
