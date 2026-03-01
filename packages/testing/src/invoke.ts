import type {
  CraftContext,
  Destination,
  ExchangeHeaders,
} from "@routecraft/routecraft";
import { DefaultExchange } from "@routecraft/routecraft";

/** Duck-type: object with send(exchange) returning Promise. */
function isDestination(obj: unknown): obj is Destination<unknown, unknown> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { send?: unknown }).send === "function"
  );
}

/**
 * Invoke a route by id or send to a destination and return the result.
 *
 * - **By route id:** Pass a string. The route is looked up with ctx.getRouteById(routeId).
 *   The route's source must implement Destination (e.g. DirectAdapter). Works with multiple
 *   routes in the default export — use the route's id.
 *
 * - **By destination:** Pass a Destination instance (e.g. direct("endpoint")). Builds an
 *   exchange and calls destination.send(exchange).
 *
 * @param ctx CraftContext (e.g. t.ctx from TestContext) with routes started
 * @param routeIdOrDestination Route id string or a Destination adapter instance
 * @param body Request body
 * @param headers Optional headers for the exchange
 * @returns The result from the route or destination (e.g. response body for DirectAdapter)
 */
export async function invoke<T = unknown, R = T>(
  ctx: CraftContext,
  routeIdOrDestination: string | Destination<T, R>,
  body: T,
  headers?: ExchangeHeaders,
): Promise<R> {
  const exchange = new DefaultExchange(ctx, {
    body,
    ...(headers !== undefined && { headers }),
  });
  let dest: Destination<T, R>;

  if (typeof routeIdOrDestination === "string") {
    const route = ctx.getRouteById(routeIdOrDestination);
    if (!route) {
      throw new Error(
        `No route with id "${routeIdOrDestination}". Did you start the context (e.g. await t.test())?`,
      );
    }
    const source = route.definition.source;
    if (!isDestination(source)) {
      throw new Error(
        `Route "${routeIdOrDestination}" is not invokable: source must implement Destination (e.g. direct adapter).`,
      );
    }
    dest = source as Destination<T, R>;
  } else {
    dest = routeIdOrDestination;
  }

  const result = await dest.send(exchange as Parameters<typeof dest.send>[0]);
  return result as R;
}
