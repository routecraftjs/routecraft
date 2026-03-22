import type { Exchange } from "../../exchange.ts";

export interface FileOptions {
  /**
   * File path string or function that returns the path.
   * For destinations, the function receives the exchange to enable dynamic paths.
   */
  path: string | ((exchange: Exchange) => string);
  /**
   * File operation mode.
   * - 'read': Read file (source mode)
   * - 'write': Write/overwrite file (destination mode)
   * - 'append': Append to file (destination mode)
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append";
  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;
  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;
}
