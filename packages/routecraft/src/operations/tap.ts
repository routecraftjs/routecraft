import { type Adapter, type StepDefinition } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { RouteCraftError, ErrorCode } from "../error.ts";

export type CallableTap<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<void> | void;

export interface Tap<T = unknown> extends Adapter {
  tap: CallableTap<T>;
}

export class TapStep<T = unknown> implements StepDefinition<Tap<T>> {
  operation: OperationType = OperationType.TAP;
  adapter: Tap<T>;

  constructor(adapter: Tap<T> | CallableTap<T>) {
    this.adapter = typeof adapter === "function" ? { tap: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange<T>; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void> {
    // Create a deep copy of the exchange for the tap
    const exchangeCopy: Exchange<T> = {
      ...exchange,
      body: structuredClone(exchange.body),
      headers: structuredClone(exchange.headers),
    };

    try {
      // Tap is not considered a critical step, so we don't want to throw an error
      await this.adapter.tap(exchangeCopy);
    } catch (error: unknown) {
      const err = RouteCraftError.create(error, {
        code: ErrorCode.TAP_ERROR,
        message: `Error tapping exchange ${exchangeCopy.id}`,
        suggestion:
          "Check the tap function for any errors or wrap it in a try/catch block.",
        docs: "https://routecraft.dev/docs/reference/errors#tapping-error",
      });
      exchangeCopy.logger.info(
        err,
        `Error tapping exchange ${exchangeCopy.id}`,
      );
    }
    queue.push({ exchange, steps: remainingSteps });
  }
}
