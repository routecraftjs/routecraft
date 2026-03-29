import type { Exchange } from "../../exchange.ts";

export interface CsvBaseOptions {
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
}

/** Options for CSV adapter. When chunked is true, onParseError is available. */
export type CsvOptions = CsvBaseOptions &
  (
    | {
        /**
         * When true, emit one exchange per row instead of the entire parsed array.
         * Only applies in source mode. Each exchange includes CSV_ROW and CSV_PATH headers.
         */
        chunked: true;
        /**
         * How to handle rows that fail to parse in chunked mode.
         * - 'throw': Abort on the first bad row (default)
         * - 'skip': Log a warning and continue
         */
        onParseError?: "throw" | "skip";
      }
    | {
        chunked?: false | undefined;
      }
  );

export type CsvRow = Record<string, unknown> | string[];
export type CsvData = CsvRow[];
