import type { Exchange } from "../../exchange.ts";

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
   * - 'write': Overwrite the file
   * - 'append': Append to the file (default)
   */
  mode?: "write" | "append";

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
}

/** Combined options for the source+destination overload (string path only). */
export type JsonlCombinedOptions = JsonlSourceOptions &
  Pick<JsonlDestinationOptions, "mode" | "createDirs" | "replacer">;

export type JsonlOptions =
  | JsonlSourceOptions
  | JsonlDestinationOptions
  | JsonlCombinedOptions;
