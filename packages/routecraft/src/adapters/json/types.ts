import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Transformer-mode options (current behavior).
 */
export interface JsonTransformerOptions<T = unknown, R = unknown, V = unknown> {
  /**
   * Dot-notation pointer to extract from the parsed JSON, e.g.
   * "data.items[0].name". If omitted, the full parsed JSON is returned.
   * Named `pointer` (not `path`) so file-role options and transformer
   * options never collide: `path` always means a file path.
   */
  pointer?: string;
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

/**
 * File-role options (`path` present): the adapter carries the source, send,
 * and fetch roles for a JSON file; the operation keyword selects the role.
 */
export interface JsonFileOptions {
  /**
   * File path string or function that returns the path. Presence of `path`
   * makes json() a file adapter instead of a transformer. The function form
   * receives the exchange (send/fetch roles only; the source role requires
   * a static string path).
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Create parent directories if they don't exist (send role only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Send role behavior: append to the file instead of overwriting it.
   * Mutually exclusive with `delete`. Default: false (overwrite)
   */
  append?: boolean;

  /**
   * Send role behavior: delete the JSON file instead of writing it.
   * Idempotent: an already-absent path is a no-op. The body is unchanged.
   * Mutually exclusive with `append`. Default: false
   */
  delete?: boolean;

  /**
   * Number of spaces for JSON formatting (send role only).
   * Default: 0 (compact JSON)
   * Alias: Can also use 'indent' for compatibility.
   */
  space?: number;

  /**
   * Alias for 'space'. Number of spaces for JSON formatting.
   */
  indent?: number;

  /**
   * JSON.parse reviver function (source/fetch roles).
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * JSON.stringify replacer function (send role only).
   */
  replacer?: (key: string, value: unknown) => unknown;

  /**
   * How to handle a `JSON.parse` failure on the file content (source role
   * only).
   *
   * - `'fail'` (default): `exchange:failed` fires; the route's `.error()`
   *   handler can recover.
   * - `'abort'`: `exchange:failed` fires, then the source dies
   *   (`context:error`).
   * - `'drop'`: `exchange:dropped` fires with `reason: "parse-failed"`.
   *
   * See `OnParseError` for full semantics.
   *
   * @default "fail"
   */
  onParseError?: OnParseError;
}

export type JsonOptions<T = unknown, R = unknown, V = unknown> =
  JsonTransformerOptions<T, R, V> | JsonFileOptions;
