/**
 * Cron expression with autocomplete for nicknames and common patterns.
 * Accepts any valid cron string (5-field or 6-field) as well.
 */
export type CronExpression =
  | "@yearly" // Once a year (Jan 1 at midnight)
  | "@annually" // Once a year (Jan 1 at midnight)
  | "@monthly" // Once a month (1st at midnight)
  | "@weekly" // Once a week (Sunday at midnight)
  | "@daily" // Once a day (at midnight)
  | "@midnight" // Once a day (at midnight)
  | "@hourly" // Once an hour (at minute 0)
  | "* * * * *" // Every minute
  | "*/5 * * * *" // Every 5 minutes
  | "*/15 * * * *" // Every 15 minutes
  | "*/30 * * * *" // Every 30 minutes
  | "0 * * * *" // Every hour (at minute 0)
  | "0 0 * * *" // Daily at midnight
  | "0 0 * * 0" // Weekly on Sunday at midnight
  | "0 0 1 * *" // Monthly on the 1st at midnight
  | "0 0 1 1 *" // Yearly on Jan 1 at midnight
  | (string & {}); // Any valid 5-field or 6-field cron expression

/** Configuration options for the cron source adapter. */
export interface CronOptions {
  /**
   * IANA timezone for the cron schedule (e.g., "America/New_York")
   * @default undefined (system timezone)
   */
  timezone?: string;

  /**
   * Maximum number of times the cron job will fire before stopping.
   * Delegated to croner's `maxRuns` option.
   * @default Infinity
   */
  maxFires?: number;

  /**
   * Random delay in milliseconds added to each trigger to prevent
   * synchronized spikes in distributed deployments.
   * Recommended: 1000-30000 for production workloads.
   * Can be set globally via `ADAPTER_CRON_OPTIONS` in the context store.
   * @default 0
   */
  jitterMs?: number;

  /**
   * Human-readable name for the cron job, used in headers for observability
   * @default undefined
   */
  name?: string;

  /**
   * If true, prevents the job from running if the previous execution
   * (including any jitter delay) is still in progress. Delegated to
   * croner's `protect` option.
   * @default true
   */
  protect?: boolean;

  /**
   * Date or ISO 8601 string at which the cron job should start running.
   * Ticks before this date are skipped.
   * @default undefined (starts immediately)
   */
  startAt?: Date | string;

  /**
   * Date or ISO 8601 string at which the cron job should stop running.
   * The job is permanently stopped once this date is reached.
   * @default undefined (runs indefinitely)
   */
  stopAt?: Date | string;
}
