import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

export interface CsvOptions {
  /**
   * File path for source/destination mode.
   * Required for source/destination mode.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Whether the CSV has a header row (source mode) or should include headers (destination mode).
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
   * File operation mode (destination mode only).
   * - 'write': Write/overwrite file
   * - 'append': Append to file
   * Default: 'write'
   */
  mode?: "write" | "append";

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
   * @experimental
   */
  onParseError?: OnParseError;
}

export type CsvRow = Record<string, unknown> | string[];
export type CsvData = CsvRow[];
