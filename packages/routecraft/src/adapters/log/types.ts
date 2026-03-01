/** Pino-compatible log levels for LogAdapter. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Options for LogAdapter. */
export interface LogOptions {
  /** Log level to use (default: "info"). */
  level?: LogLevel;
}
