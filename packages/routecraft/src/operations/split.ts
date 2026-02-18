import { randomUUID } from "node:crypto";
import { type Adapter, type Step } from "../types.ts";
import { INTERNALS_KEY } from "../brand.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
  EXCHANGE_INTERNALS,
} from "../exchange.ts";
import type { Route } from "../route.ts";

export type CallableSplitter<T = unknown, R = unknown> = (
  body: T,
) => Promise<R[]> | R[];

export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split: CallableSplitter<T, R>;
}

export class SplitStep<T = unknown, R = unknown> implements Step<
  Splitter<T, R>
> {
  operation: OperationType = OperationType.SPLIT;
  adapter: Splitter<T, R>;

  constructor(adapter: Splitter<T, R> | CallableSplitter<T, R>) {
    this.adapter = typeof adapter === "function" ? { split: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const splitBodies = await Promise.resolve(
      this.adapter.split(exchange.body),
    );
    const groupId = randomUUID();

    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);

    if (!context) {
      throw new Error("Exchange has no context — cannot execute split");
    }

    const existingHierarchy =
      (exchange.headers[HeadersKeys.SPLIT_HIERARCHY] as string[]) || [];
    const splitHierarchy = [...existingHierarchy, groupId];

    splitBodies.forEach((body) => {
      const postProcessedExchange = new DefaultExchange<R>(context, {
        id: randomUUID(),
        body,
        headers: {
          ...exchange.headers,
          [HeadersKeys.SPLIT_HIERARCHY]: splitHierarchy,
        },
      });

      // Set route in internals if it exists (symbol-key for cross-instance)
      if (route) {
        const internals =
          (
            postProcessedExchange as Exchange & {
              [key: symbol]: { context: unknown; route?: Route };
            }
          )[INTERNALS_KEY] ?? EXCHANGE_INTERNALS.get(postProcessedExchange);
        if (internals) {
          internals.route = route as Route;
        }
      }

      postProcessedExchange.logger.debug(
        `Pushing split exchange ${postProcessedExchange.id} to queue, splitHierarchy: ${postProcessedExchange.headers[HeadersKeys.SPLIT_HIERARCHY]}`,
      );
      queue.push({
        exchange: postProcessedExchange,
        steps: remainingSteps,
      });
    });
  }
}
