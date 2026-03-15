export interface CronOptions {
  /**
   * IANA timezone for the cron schedule (e.g., "America/New_York")
   * @default undefined (system timezone)
   */
  timezone?: string;

  /**
   * Maximum number of times the cron job will fire before stopping
   * @default Infinity
   */
  maxFires?: number;

  /**
   * Random delay in milliseconds added to each trigger to prevent synchronized spikes
   * @default 0
   */
  jitterMs?: number;

  /**
   * Human-readable name for the cron job, used in headers for observability
   * @default undefined
   */
  name?: string;
}
