import { type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  cloneExchange,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { type Destination, type CallableDestination } from "./to.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";

/**
 * Step that runs a destination as a side effect without changing the main exchange.
 * The tap runs asynchronously (route.trackTask); the main flow continues immediately.
 * Tap receives a snapshot of the exchange (body/headers cloned). Errors are emitted as `error` and rethrown for observability.
 */
export class TapStep<T = unknown> implements Step<Destination<T, unknown>> {
  operation: OperationType = OperationType.TAP;
  label?: string;
  adapter: Destination<T, unknown>;

  constructor(
    adapter: Destination<T, unknown> | CallableDestination<T, unknown>,
  ) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);

    if (!context || !route) {
      throw new Error("Exchange has no context or route; cannot execute tap");
    }

    // Tap runs against a deep clone so a tap-side body mutation cannot
    // race the main pipeline. The clone gets a fresh id (so logs can
    // distinguish tap from the main flow) while preserving the
    // correlation id; tap is for observation, not mutation.
    const snapshot = cloneExchange(exchange, context);

    // Resolve a test-time override (if any) so `.tap(adapter)` is intercepted
    // the same way `.to()` and `.enrich()` are.
    const override = resolveAdapterOverride(this.adapter, context);

    const promise = (async () => {
      try {
        // Adapter metadata (getMetadata) is intentionally NOT collected
        // here: the tap runs detached, so this exchange's step:completed
        // event has already been emitted by the time send() resolves and
        // any metadata written now would be misattributed to a later
        // exchange's event.
        if (override) {
          await invokeSendOverride(
            snapshot,
            this.adapter as unknown as Destination<unknown, unknown>,
            override,
          );
        } else {
          await this.adapter.send(snapshot);
        }
      } catch (error: unknown) {
        const err = rcError("RC5001", error, {
          message: `Error tapping exchange ${snapshot.id}`,
          suggestion:
            "Tap errors can be handled in the route-level error() operation.",
        });
        const tapLabel = this.label ?? "tap";
        context.emit("route:step:error", {
          routeId: route.definition.id,
          error: err,
          route,
          exchange: snapshot,
          operation: tapLabel,
        });
        throw err; // Reject for observability
      }
    })();

    route.trackTask(promise);

    return { kind: "continue", exchange };
  }
}
