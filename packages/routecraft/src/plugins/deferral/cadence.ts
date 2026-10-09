import type { PluginLogger } from "../../kernel/plugin.ts";

/**
 * The longest interval `setInterval` schedules as written; above it the
 * delay is coerced to 1ms and the sweep would run back to back.
 */
export const MAX_SWEEP_INTERVAL_MS = 2_147_483_647;

/**
 * When the kernel's sweep runs: on an interval, one pass at a time.
 *
 * The pass is the kernel's (`execution.sweep()`); this only decides when.
 */
export class SweepCadence {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(
    private readonly sweep: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly logger: PluginLogger,
  ) {}

  /** Begin sweeping on the interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.sweep()
        .catch((err: unknown) => {
          this.logger.error(
            { err },
            "Deferral sweep failed; the next tick will retry.",
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.intervalMs);
    // A sweep must never be the reason a process stays alive: it serves
    // routes, and an application whose routes have all finished should exit.
    this.timer.unref?.();
  }

  /**
   * Stop the interval and wait for the pass in flight, so the store is not
   * closed underneath it. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
