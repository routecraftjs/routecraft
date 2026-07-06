import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  type OperationType,
} from "../exchange.ts";
import type { CraftContext } from "../context.ts";
import type { Route } from "../route.ts";

/**
 * Per-exchange event-scope bindings shared by every resilience wrapper's
 * `runInner`. Derives the route, context, route id, step label, and
 * correlation id once so the wrappers (`.delay()`, `.timeout()`,
 * `.retry()`, `.throttle()`, `.cache()`) stop hand-rolling the same six
 * lines.
 *
 * Returned for DESTRUCTURING rather than as a ready-made `shouldEmit`
 * flag on purpose: the caller keeps its own
 * `const shouldEmit = route && context && routeId`, which lets
 * TypeScript's aliased-condition narrowing prove `context` is defined
 * inside the emit guard. A boolean returned from here would not narrow
 * the separately-returned `context`, forcing every call site to
 * re-assert it.
 *
 * @param exchange Live exchange whose internals carry the route / context.
 * @param step The wrapper step; `label` and `operation` form the display
 *   label.
 * @returns The scope bindings. `route` / `context` are `undefined` when the
 *   exchange has no attached route (e.g. a step run in isolation), so the
 *   caller's `shouldEmit` is falsy and no events fire. `routeId` falls back
 *   to the `routecraft.route` header (always populated by the
 *   `DefaultExchange` constructor) so flow-control operations that emit
 *   with only a context binding still carry a stable id.
 * @internal
 */
export function wrapperEventScope(
  exchange: Exchange,
  step: { label?: string; operation: OperationType },
): {
  route: Route | undefined;
  context: CraftContext | undefined;
  routeId: string;
  stepLabel: string;
  correlationId: string;
} {
  const route = getExchangeRoute(exchange);
  return {
    route,
    context: getExchangeContext(exchange),
    routeId:
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string),
    stepLabel: step.label ?? String(step.operation),
    correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
  };
}
