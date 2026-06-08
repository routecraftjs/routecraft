import type { Exchange } from "../../exchange.ts";

export interface FileOptions {
  /**
   * File path string or function that returns the path.
   * For destinations, the function receives the exchange to enable dynamic paths.
   */
  path: string | ((exchange: Exchange) => string);
  /**
   * File operation mode.
   * - 'read': Read the file. Works as a source (`.from`) and, because read mode
   *   returns the content, mid-route via `.enrich()` / `.to()`. Read-as-
   *   destination also supports dynamic (function) paths.
   * - 'write': Write/overwrite file (destination mode)
   * - 'append': Append to file (destination mode)
   * - 'delete': Delete the file (destination mode). Idempotent: an already-
   *   absent path is a no-op. The body is unchanged. Supports dynamic paths.
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append" | "delete";
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
   * When true, emit one exchange per line instead of the entire file content.
   * Only applies in source mode. Each exchange includes FILE_LINE and FILE_PATH headers.
   * Default: false
   */
  chunked?: boolean;
}
