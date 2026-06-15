import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  cloneExchange,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";

/**
 * Marker adapter for the MulticastStep. Exposes no configuration; the paths
 * live on the step itself.
 */
export interface MulticastAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.multicast";
}

/**
 * Step that fans the exchange out to multiple independent paths in parallel.
 *
 * Each path receives its own deep clone of the exchange (fresh id, preserved
 * correlation id) and runs as an isolated nested pipeline. All paths run
 * concurrently and the step waits for every one to settle
 * (`Promise.allSettled` semantics): a path that throws fires that clone's own
 * error events but does not fail the route or its sibling paths, and a path
 * that `.halt()`s only stops itself. Once every path has settled the ORIGINAL
 * exchange continues downstream unchanged.
 *
 * Path failures do NOT reach the route-scope `.error()` handler: each path is
 * a self-contained sub-flow whose failure resolves through its own clone's
 * default error events. Only the body is deep-copied; object-valued user
 * headers are shared by reference across clones (mutating a nested header
 * field from a path is not isolated). The body must be structured-cloneable;
 * a non-cloneable body fails this step.
 *
 * Fire-and-forget is intentionally not offered here; use `tap` (already
 * fire-and-forget) for that.
 */
export class MulticastStep<In = unknown> implements Step<MulticastAdapter> {
  operation: OperationType = OperationType.MULTICAST;
  adapter: MulticastAdapter = { adapterId: "routecraft.operation.multicast" };

  constructor(private readonly paths: Step<Adapter>[][]) {}

  async execute(
    exchange: Exchange<In>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // With no context there is nothing to run paths against; pass the
    // exchange through unchanged. In practice the executor always supplies a
    // context, so this is a defensive no-op.
    if (!context) {
      return { kind: "continue", exchange };
    }

    // Emit started/stopped unconditionally and pair them with try/finally so
    // a `started` is ALWAYS followed by a `stopped`, even if a path clone
    // throws (a non-cloneable body) or the fan-out is empty. The cloning and
    // fan-out only happen when there are paths to run.
    context.emit("route:operation:multicast:started", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      pathCount: this.paths.length,
    });
    try {
      if (this.paths.length > 0) {
        // Clone once per path so each path mutates an independent copy, binding
        // the (already-derived) route so the clone is executor-ready, then run
        // them all in parallel and wait for every one to settle.
        await ctx.runPaths(
          this.paths.map((steps) => ({
            steps,
            exchange: cloneExchange(exchange, context, route),
          })),
        );
      }
    } finally {
      context.emit("route:operation:multicast:stopped", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        pathCount: this.paths.length,
      });
    }

    // The original exchange continues downstream unchanged.
    return { kind: "continue", exchange };
  }
}
