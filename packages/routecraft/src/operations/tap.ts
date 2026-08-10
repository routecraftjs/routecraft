import type { Adapter, Step, StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  cloneExchange,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import type { Destination, SendContext } from "./to.ts";
import type { Enricher } from "./enrich.ts";
import { hasSend, hasFetch, missingSlotError } from "./adapter-roles.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";

/**
 * Function form of a tap. One signature covers both role shapes (a
 * {@link CallableDestination} written for `.to()` and a
 * {@link CallableEnricher}) so either drops into `.tap()` unchanged and the
 * exchange parameter stays contextually typed: the `ctx` is a
 * {@link SendContext} (its `setHeader` sink discards receipts with the
 * snapshot), and any returned value is discarded.
 *
 * @template T - Current body type
 */
export type TapCallable<T = unknown, Ex extends Exchange<T> = Exchange<T>> = (
  exchange: Ex,
  ctx?: SendContext,
) => unknown;

/**
 * Anything `.tap()` accepts: a Destination (send), an Enricher (fetch and
 * discard), or a function form. Results are always discarded; a tap
 * observes.
 *
 * @template T - Current body type
 */
export type TapTarget<T = unknown, Ex extends Exchange<T> = Exchange<T>> =
  Destination<T> | Enricher<T, unknown> | TapCallable<T, Ex>;

/**
 * Step that runs a destination (or enricher) as a side effect without changing
 * the main exchange. The tap runs asynchronously (route.trackTask); the main
 * flow continues immediately. Tap receives a snapshot of the exchange
 * (body/headers cloned). `send` is preferred when both slots exist; a
 * fetch-only adapter is invoked and its result discarded. Receipt headers set
 * through the {@link SendContext} sink are discarded with the snapshot.
 * Errors are emitted as `error` and rethrown for observability.
 */
export class TapStep<T = unknown> implements Step<Adapter> {
  operation: OperationType = OperationType.TAP;
  label?: string;
  adapter: Adapter;
  /** Function form, when constructed from a bare callable. */
  private readonly callable: TapCallable<T> | undefined;

  constructor(target: TapTarget<T>) {
    if (typeof target === "function") {
      this.callable = target;
      this.adapter = { send: target } as Adapter;
    } else {
      this.callable = undefined;
      this.adapter = target;
    }
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
    const override = resolveAdapterOverride(this.adapter, context, "send");

    const promise = (async () => {
      try {
        // Adapter metadata (getMetadata) is intentionally NOT collected
        // here: the tap runs detached, so this exchange's step:completed
        // event has already been emitted by the time the call resolves and
        // any metadata written now would be misattributed to a later
        // exchange's event.
        // No signal on purpose: the tap runs detached from the main flow
        // (its outcome never gates the pipeline), so an enclosing timeout
        // abandoning the ATTEMPT must not cancel an observation already in
        // flight. Mirrors captureDownstream's no-inherited-abort-signal
        // contract. The header sink swallows receipts: they would only
        // ever decorate the discarded snapshot. Function forms get the
        // same sink so a callable written for `.to()` behaves identically.
        const sink: SendContext = { setHeader: () => undefined };
        if (override) {
          await invokeSendOverride(snapshot, this.adapter, override);
        } else if (this.callable) {
          await Promise.resolve(this.callable(snapshot, sink));
        } else if (hasSend<T>(this.adapter)) {
          await Promise.resolve(this.adapter.send(snapshot, sink));
        } else if (hasFetch<T, unknown>(this.adapter)) {
          await Promise.resolve(this.adapter.fetch(snapshot, {}));
        } else {
          throw missingSlotError("`.tap()`");
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
