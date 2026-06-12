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

/**
 * Header keys the file source sets on chunked-mode exchanges. Keys live
 * under the reserved `routecraft.file.*` namespace; the value types are
 * merged into `RoutecraftHeaders` below.
 */
export const FileHeaders = {
  /** The 1-based line number when reading a file in chunked mode */
  LINE: "routecraft.file.line",
  /** The file path when reading a file in chunked mode */
  PATH: "routecraft.file.path",
} as const satisfies Record<string, `routecraft.file.${string}`>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The 1-based line number when reading a file in chunked mode */
    [FileHeaders.LINE]?: number;
    /** The file path when reading a file in chunked mode */
    [FileHeaders.PATH]?: string;
  }
}
