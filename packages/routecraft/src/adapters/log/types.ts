/**
 * Pino-compatible log levels for LogAdapter.
 *
 * @beta
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Options for LogAdapter.
 *
 * @beta
 */
export interface LogOptions {
  /** Log level to use (default: "info"). */
  level?: LogLevel;
}
