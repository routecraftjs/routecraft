import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Parsing/formatting options shared by transformer and file modes.
 */
export interface CsvParseOptions {
  /**
   * Whether the CSV has a header row (parse) or should include headers (format).
   * Default: true
   */
  header?: boolean;

  /**
   * Field delimiter. Default: ','
   */
  delimiter?: string;

  /**
   * Quote character. Default: '"'
   */
  quoteChar?: string;

  /**
   * Skip empty lines. Default: true
   */
  skipEmptyLines?: boolean;
}

/**
 * Transformer-mode options (no `path`): parse a CSV string already in the body.
 */
export interface CsvTransformerOptions<
  T = unknown,
  R = unknown,
> extends CsvParseOptions {
  /**
   * Pluck the CSV string from the body. If omitted: body is used when it's a
   * string, or body.body when body is an object (e.g. after http()).
   */
  from?: (body: T) => string;

  /**
   * Where to put the parsed rows. If omitted, the result replaces the entire
   * body. Use e.g. (body, rows) => ({ ...body, rows }) to write to a sub-field.
   */
  to?: (body: T, result: CsvData) => R;
}

/**
 * Source/Destination mode options (with `path`).
 */
export interface CsvFileOptions extends CsvParseOptions {
  /**
   * File path for source/destination mode.
   */
  path: string | ((exchange: Exchange) => string);

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
   * File operation mode.
   * - 'read': Read + parse the CSV file. Works as a source (`.from`) and,
   *   because read mode returns the parsed rows, mid-route via `.enrich()` /
   *   `.to()`. As a destination, parse failures throw (the route boundary
   *   surfaces them as `exchange:failed`); the `onParseError` lifecycle controls
   *   apply to source mode only.
   * - 'write': Write/overwrite file (destination mode)
   * - 'append': Append to file (destination mode)
   * - 'delete': Delete the CSV file (destination mode). Idempotent: an already-
   *   absent path is a no-op. The body is unchanged. Supports dynamic paths.
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append" | "delete";

  /**
   * When true, emit one exchange per row instead of the entire parsed array.
   * Only applies in source mode. Each exchange includes CSV_ROW and CSV_PATH headers.
   * Default: false
   */
  chunked?: boolean;

  /**
   * How to handle a Papa Parse row error (chunked mode) or parse error
   * (non-chunked mode).
   *
   * - `'fail'` (default): `exchange:failed` fires for the bad row; the
   *   route's `.error()` handler can recover; chunked mode continues to
   *   the next row.
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

export type CsvOptions<T = unknown, R = unknown> =
  | CsvTransformerOptions<T, R>
  | CsvFileOptions;

export type CsvRow = Record<string, unknown> | string[];
export type CsvData = CsvRow[];

/**
 * Header keys the CSV source sets on chunked-mode exchanges. Keys live
 * under the reserved `routecraft.csv.*` namespace; the value types are
 * merged into `RoutecraftHeaders` below.
 */
export const CsvHeaders = {
  /** The 1-based row number when reading a CSV file in chunked mode */
  ROW: "routecraft.csv.row",
  /** The file path when reading a CSV file in chunked mode */
  PATH: "routecraft.csv.path",
} as const satisfies Record<string, `routecraft.csv.${string}`>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The 1-based row number when reading a CSV file in chunked mode */
    [CsvHeaders.ROW]?: number;
    /** The file path when reading a CSV file in chunked mode */
    [CsvHeaders.PATH]?: string;
  }
}
