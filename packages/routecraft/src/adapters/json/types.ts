import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

// Transformer-mode options (current behavior)
export interface JsonTransformerOptions<T = unknown, R = unknown, V = unknown> {
  /**
   * Dot-notation path to extract from the parsed JSON, e.g. "data.items[0].name".
   * If omitted, the full parsed JSON is returned.
   * NOTE: In transformer mode only. In file mode, this parameter is the file path.
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

// Source/Destination mode options (new behavior)
export interface JsonFileOptions {
  /**
   * File path string or function that returns the path.
   * Makes json() a source/destination adapter instead of a transformer.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * File operation mode.
   * - 'read': Read JSON file (source mode)
   * - 'write': Write/overwrite JSON file (destination mode)
   * - 'append': Append to JSON file (destination mode)
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append";

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Number of spaces for JSON formatting (destination mode only).
   * Default: 0 (compact JSON)
   * Alias: Can also use 'indent' for compatibility.
   */
  space?: number;

  /**
   * Alias for 'space'. Number of spaces for JSON formatting.
   */
  indent?: number;

  /**
   * JSON.parse reviver function (source mode only).
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * JSON.stringify replacer function (destination mode only).
   */
  replacer?: (key: string, value: unknown) => unknown;

  /**
   * How to handle a `JSON.parse` failure on the file content (source mode
   * only). Default `'fail'`: the exchange fails so the route's `.error()`
   * handler can catch it (or `exchange:failed` fires). `'abort'` rethrows
   * out of the source. `'skip'` silently logs at warn and emits no
   * exchange. See `OnParseError` for full semantics.
   *
   * @default "fail"
   * @experimental
   */
  onParseError?: OnParseError;
}

export type JsonOptions<T = unknown, R = unknown, V = unknown> =
  | JsonTransformerOptions<T, R, V>
  | JsonFileOptions;
