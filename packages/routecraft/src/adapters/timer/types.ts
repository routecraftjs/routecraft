export interface TimerOptions {
  /**
   * Time between executions in milliseconds
   * @default 1000
   */
  intervalMs?: number;

  /**
   * Delay before the first execution in milliseconds
   * @default 0
   */
  delayMs?: number;

  /**
   * Number of times to trigger before stopping
   * @default Infinity
   */
  repeatCount?: number;

  /**
   * Ensures execution happens at exact intervals (ignoring execution time)
   * @default false
   */
  fixedRate?: boolean;

  /**
   * Executes at an exact time of day (ISO HH:mm:ss)
   * @default null
   */
  exactTime?: string;

  /**
   * Allows custom date formats for execution times
   * @default null
   */
  timePattern?: string;

  /**
   * Adds random delay to prevent synchronized execution spikes
   * @default 0
   */
  jitterMs?: number;
}
