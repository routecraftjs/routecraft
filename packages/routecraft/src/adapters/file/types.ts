import type { Exchange } from "../../exchange.ts";

export interface FileOptions {
  /**
   * File path string or function that returns the path.
   * The function form receives the exchange (send/fetch roles only; the
   * source role needs a static string because no exchange exists yet).
   */
  path: string | ((exchange: Exchange) => string);
  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;
  /**
   * Create parent directories if they don't exist (send role only).
   * Default: false
   */
  createDirs?: boolean;
  /**
   * Send role behavior: append to the file instead of overwriting it.
   * Mutually exclusive with `delete`. Default: false (overwrite)
   */
  append?: boolean;
  /**
   * Send role behavior: delete the file instead of writing it. Idempotent:
   * an already-absent path is a no-op. The body is unchanged. Mutually
   * exclusive with `append`. Default: false
   */
  delete?: boolean;
  /**
   * When true, the source emits one exchange per line instead of the entire
   * file content. Source role only; the send/fetch roles are identical under
   * chunked. Each chunked exchange includes FILE_LINE and FILE_PATH headers.
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
