import { randomUUID } from "node:crypto";
import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  OperationType,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { type Destination, type CallableDestination } from "./to.ts";
import type { CraftContext } from "../context.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";

/**
 * Creates a snapshot of an exchange for async tap execution.
 * Deep-clones body and headers; correlation id is preserved. Used so tap can run in the background without mutating the main exchange.
 *
 * @internal
 */
function snapshotExchange<T>(
  exchange: Exchange<T>,
  context: CraftContext,
): Exchange<T> {
  return new DefaultExchange<T>(context, {
    id: randomUUID(),
    body: structuredClone(exchange.body),
    headers: { ...exchange.headers },
    principal: exchange.principal,
  });
}

/**
 * Step that runs a destination as a side effect without changing the main exchange.
 * The tap runs asynchronously (route.trackTask); the main flow continues immediately.
 * Tap receives a snapshot of the exchange (body/headers cloned). Errors are emitted as `error` and rethrown for observability.
 */
export class TapStep<T = unknown> implements Step<Destination<T, unknown>> {
  operation: OperationType = OperationType.TAP;
  label?: string;
  adapter: Destination<T, unknown>;
  metadata?: Record<string, unknown>;

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
      throw new Error("Exchange has no context or route; cannot execute tap");
    }

    const snapshot = snapshotExchange(exchange, context);

    // Resolve a test-time override (if any) so `.tap(adapter)` is intercepted
    // the same way `.to()` and `.enrich()` are.
    const override = resolveAdapterOverride(this.adapter, context);

    const promise = (async () => {
      try {
        const result = override
          ? await invokeSendOverride(
              snapshot,
              this.adapter as unknown as Destination<unknown, unknown>,
              override,
            )
          : await this.adapter.send(snapshot);

        // Extract metadata if the adapter provides it (skip when overridden;
        // mock results are typically primitives and have no adapter metadata).
        const getMetadata = (
          this.adapter as {
            getMetadata?: (result: unknown) => Record<string, unknown>;
          }
        ).getMetadata;
        if (!override && getMetadata) {
          this.metadata = getMetadata.call(this.adapter, result);
        }
      } catch (error: unknown) {
        const err = rcError("RC5001", error, {
          message: `Error tapping exchange ${snapshot.id}`,
          suggestion:
            "Tap errors can be handled in the route-level error() operation.",
        });
        const tapLabel = this.label ?? "tap";
        context.emit(
          `route:${route.definition.id}:step:${tapLabel}:error` as const,
          {
            error: err,
            route,
            exchange: snapshot,
            operation: tapLabel,
          },
        );
        throw err; // Reject for observability
      }
    })();

    route.trackTask(promise);

    queue.push({ exchange, steps: remainingSteps });
  }
}
