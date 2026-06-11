import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

export interface JsonlSourceOptions {
  /**
   * File path to the JSONL file.
   */
  path: string;

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * When true, emit one exchange per line instead of a parsed array.
   * Each exchange includes JSONL_LINE and JSONL_PATH headers.
   * Default: false
   */
  chunked?: boolean;

  /**
   * Optional reviver function passed to JSON.parse.
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * How to handle a `JSON.parse` failure on a line (chunked mode) or any
   * line of the file (non-chunked mode).
   *
   * - `'fail'` (default): `exchange:failed` fires for the bad line; the
   *   route's `.error()` handler can recover; chunked mode continues.
   * - `'abort'`: `exchange:failed` fires, then the source dies
   *   (`context:error`).
   * - `'drop'`: `exchange:dropped` fires with `reason: "parse-failed"`;
   *   chunked mode continues.
   *
   * See `OnParseError` for full semantics.
   *
   * @default "fail"
   */
  onParseError?: OnParseError;
}

export interface JsonlDestinationOptions {
  /**
   * File path string or function that returns the path.
   * The function receives the exchange to enable dynamic paths.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * File operation mode.
   * - 'read': Read + parse the JSONL file and return the array, so the adapter
   *   works mid-route via `.enrich()` / `.to()` (like an HTTP GET). Parse
   *   failures throw; the route boundary surfaces them as `exchange:failed`.
   * - 'write': Overwrite the file
   * - 'append': Append to the file (default)
   * - 'delete': Delete the file (destination mode). Idempotent: an already-
   *   absent path is a no-op. The body is unchanged. Supports dynamic paths.
   */
  mode?: "read" | "write" | "append" | "delete";

  /**
   * Create parent directories if they don't exist.
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Optional replacer passed to JSON.stringify.
   * Can be a function or an array of allowed keys.
   */
  replacer?:
    | ((key: string, value: unknown) => unknown)
    | Array<string | number>
    | null;

  /**
   * Optional reviver passed to JSON.parse (read mode only).
   */
  reviver?: (key: string, value: unknown) => unknown;
}

/**
 * Transformer-mode options (no `path`): parse a JSONL string already in the
 * body into an array.
 */
export interface JsonlTransformerOptions<T = unknown, R = unknown> {
  /**
   * Pluck the JSONL string from the body. If omitted: body is used when it's a
   * string, or body.body when body is an object (e.g. after http()).
   */
  from?: (body: T) => string;

  /**
   * Where to put the parsed array. If omitted, the result replaces the entire
   * body. Use e.g. (body, rows) => ({ ...body, rows }) to write to a sub-field.
   */
  to?: (body: T, result: unknown[]) => R;

  /**
   * Optional reviver passed to JSON.parse.
   */
  reviver?: (key: string, value: unknown) => unknown;
}

/**
 * Combined options for the source+destination overload (string path only).
 */
export type JsonlCombinedOptions = JsonlSourceOptions &
  Pick<JsonlDestinationOptions, "mode" | "createDirs" | "replacer">;

export type JsonlOptions =
  | JsonlSourceOptions
  | JsonlDestinationOptions
  | JsonlCombinedOptions
  | JsonlTransformerOptions;

/**
 * Header keys the JSONL source sets on chunked-mode exchanges. Keys live
 * under the reserved `routecraft.jsonl.*` namespace; the value types are
 * merged into `RoutecraftHeaders` below.
 */
export const JsonlHeaders = {
  /** The 1-based line number when reading a JSONL file in chunked mode */
  LINE: "routecraft.jsonl.line",
  /** The file path when reading a JSONL file in chunked mode */
  PATH: "routecraft.jsonl.path",
} as const satisfies Record<string, `routecraft.jsonl.${string}`>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The 1-based line number when reading a JSONL file in chunked mode */
    "routecraft.jsonl.line"?: number;
    /** The file path when reading a JSONL file in chunked mode */
    "routecraft.jsonl.path"?: string;
  }
}
