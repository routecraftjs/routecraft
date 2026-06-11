import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Single options type for the jsonl file family (source AND destination),
 * discriminated by `mode` (plus `chunked` for the per-line source). This is
 * the file-family pattern shared with `JsonFileOptions` / `CsvFileOptions`:
 * one options shape per adapter, mode picks the behaviour.
 */
export interface JsonlFileOptions {
  /**
   * File path string or function that returns the path. Function paths
   * receive the exchange (dynamic paths) and are destination-only; source
   * mode requires a static string path.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * File operation mode.
   * - 'read': Read + parse the JSONL file and return the array. Works as a
   *   source (`.from`) and, because read mode returns the parsed array,
   *   mid-route via `.enrich()` / `.to()` (like an HTTP GET). As a
   *   destination, parse failures throw (the route boundary surfaces them
   *   as `exchange:failed`); the `onParseError` lifecycle controls apply to
   *   source mode only.
   * - 'write': Overwrite the file (destination mode)
   * - 'append': Append to the file (destination mode, default)
   * - 'delete': Delete the file (destination mode). Idempotent: an already-
   *   absent path is a no-op. The body is unchanged. Supports dynamic paths.
   */
  mode?: "read" | "write" | "append" | "delete";

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * When true, emit one exchange per line instead of a parsed array.
   * Only applies in source mode. Each exchange includes `JsonlHeaders.LINE`
   * and `JsonlHeaders.PATH` headers.
   * Default: false
   */
  chunked?: boolean;

  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Optional reviver function passed to JSON.parse (read/source mode).
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * Optional replacer passed to JSON.stringify (write modes).
   * Can be a function or an array of allowed keys.
   */
  replacer?:
    | ((key: string, value: unknown) => unknown)
    | Array<string | number>
    | null;

  /**
   * How to handle a `JSON.parse` failure on a line (chunked mode) or any
   * line of the file (non-chunked mode). Source mode only.
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

export type JsonlOptions = JsonlFileOptions | JsonlTransformerOptions;

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
