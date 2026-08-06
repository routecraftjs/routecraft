import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Single options type for the jsonl file family: one options shape per
 * adapter, shared by all three roles (the file-family pattern shared with
 * `JsonFileOptions` / `CsvFileOptions`). The operation keyword selects the
 * role; options only tune behavior within a role.
 */
export interface JsonlFileOptions {
  /**
   * File path string or function that returns the path. Function paths
   * receive the exchange (send/fetch roles only; the source role requires a
   * static string path).
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * When true, the source emits one exchange per line instead of a parsed
   * array. Source role only; the send/fetch roles are identical under
   * chunked. Each chunked exchange includes `JsonlHeaders.LINE` and
   * `JsonlHeaders.PATH` headers.
   * Default: false
   */
  chunked?: boolean;

  /**
   * Send role behavior: append lines to the file instead of overwriting it.
   * Mutually exclusive with `delete`. Default: false (overwrite; note this
   * changed from the pre-role-model default, which appended)
   */
  append?: boolean;

  /**
   * Send role behavior: delete the file instead of writing it. Idempotent:
   * an already-absent path is a no-op. The body is unchanged. Mutually
   * exclusive with `append`. Default: false
   */
  delete?: boolean;

  /**
   * Create parent directories if they don't exist (send role only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Optional reviver function passed to JSON.parse (source/fetch roles).
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * Optional replacer passed to JSON.stringify (send role).
   * Can be a function or an array of allowed keys.
   */
  replacer?:
    ((key: string, value: unknown) => unknown) | Array<string | number> | null;

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
    [JsonlHeaders.LINE]?: number;
    /** The file path when reading a JSONL file in chunked mode */
    [JsonlHeaders.PATH]?: string;
  }
}
