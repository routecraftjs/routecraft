import { randomUUID } from "node:crypto";
import { type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
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
 * Creates a snapshot of an exchange for async tap execution. Body is
 * deep-cloned so tap-side mutations (which the framework cannot prevent
 * for arbitrary user payloads) do not race with the main pipeline.
 * Headers are framework-immutable (shallow-frozen) and safe to share
 * between snapshot and main pipeline by reference; structured header
 * values like `Principal` are shallow-frozen by the constructor so direct
 * field rewrites are caught at runtime. Taps that mutate nested fields
 * (e.g. `principal.claims.foo`) are an anti-pattern; tap is for
 * observation, not mutation.
 *
 * The snapshot gets a fresh id (overriding the parent's
 * `routecraft.id`) so log lines and any downstream identity-aware
 * tooling can distinguish tap from main pipeline.
 *
 * @internal
 */
function snapshotExchange<T>(
  exchange: Exchange<T>,
  context: CraftContext,
): Exchange<T> {
  return new DefaultExchange<T>(context, {
    body: structuredClone(exchange.body),
    headers: {
      ...exchange.headers,
      [HeadersKeys.ID]: randomUUID(),
    },
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

    const snapshot = snapshotExchange(exchange, context);

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
