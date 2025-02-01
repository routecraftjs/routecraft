import {
  type CraftContext,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/core";

export interface TimerAdapterOptions {
  /**
   * Interval in milliseconds for scheduling the timer, e.g., 5000 for every 5 seconds.
   */
  interval: number;
}

export class TimerAdapter implements Source {
  readonly adapterId = "routecraft.adapter.timer";
  constructor(private options?: TimerAdapterOptions) {}

  subscribe(
    _context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    this.options = this.options ?? { interval: 5000 };

    console.info(
      `Setting up TimerAdapter with interval ${this.options.interval}ms`,
    );

    // Schedule the timer using setInterval
    const timerId = setInterval(async () => {
      console.debug("TimerAdapter firing");
      try {
        await handler(undefined);
      } catch (error) {
        console.error("Error in TimerAdapter handler", error);
      }
    }, this.options.interval);

    // Return a promise that never resolves until the subscription is aborted.
    return new Promise((resolve) => {
      abortController.signal.addEventListener("abort", () => {
        console.info("TimerAdapter subscription aborted, stopping timer");
        clearInterval(timerId);
        resolve();
      });
    });
  }
}
