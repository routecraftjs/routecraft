import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  OperationType,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { error as rcError } from "../error.ts";
import { type Destination, type CallableDestination } from "./to.ts";
import type { CraftContext } from "../context.ts";

/**
 * Create a snapshot of an exchange for async tap execution.
 * Deep clones body and headers; correlation ID is preserved.
 */
function snapshotExchange<T>(
  exchange: Exchange<T>,
  context: CraftContext,
): Exchange<T> {
  return new DefaultExchange<T>(context, {
    id: crypto.randomUUID(),
    body: structuredClone(exchange.body),
    headers: { ...exchange.headers },
  });
}

export class TapStep<T = unknown> implements Step<Destination<T, unknown>> {
  operation: OperationType = OperationType.TAP;
  adapter: Destination<T, unknown>;

  constructor(
    adapter: Destination<T, unknown> | CallableDestination<T, unknown>,
  ) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);

    if (!context || !route) {
      throw new Error("Exchange has no context or route — cannot execute tap");
    }

    const snapshot = snapshotExchange(exchange, context);

    const promise = Promise.resolve(this.adapter.send(snapshot)).catch(
      (error: unknown) => {
        const err = rcError("RC5007", error, {
          message: `Error tapping exchange ${snapshot.id}`,
          suggestion:
            "Check the tap function for any errors or wrap it in a try/catch block.",
        });
        snapshot.logger.warn(err, `Error tapping exchange ${snapshot.id}`);
        context.emit("error", { error: err, exchange: snapshot });
      },
    );

    route.trackTask(promise);

    queue.push({ exchange, steps: remainingSteps });
  }
}
