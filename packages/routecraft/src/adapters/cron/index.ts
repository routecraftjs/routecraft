import type { Source } from "../../operations/from";
import { CronSourceAdapter } from "./source";
import type { CronExpression, CronOptions } from "./types";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";

/**
 * Creates a source that emits on a cron schedule. Body is undefined; cron metadata is in exchange headers (routecraft.cron.*).
 *
 * Supports standard 5-field cron, 6-field (with seconds), and nicknames (@daily, @weekly, @hourly, @monthly, @yearly, @annually, @midnight).
 *
 * @param expression - Cron expression string
 * @param options - timezone, maxFires, jitterMs, name, protect, startAt, stopAt
 * @returns A Source usable with `.from(cron(expression, options))`
 *
 * @example
 * ```typescript
 * .from(cron("0 9 * * 1-5"))                              // weekdays at 9am
 * .from(cron("@daily", { timezone: "America/New_York" }))  // daily in EST
 * .from(cron("0 0 1 * *", { name: "monthly-report" }))    // first of each month
 * ```
 */
export function cron(
  expression: CronExpression,
  options?: CronOptions,
): Source<undefined> {
  return tagAdapter(
    new CronSourceAdapter(expression, options),
    cron,
    factoryArgs(expression, options),
  );
}

export { CronSourceAdapter, ADAPTER_CRON_OPTIONS } from "./source";
export type { CronExpression, CronOptions } from "./types";
