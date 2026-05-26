import {
  getExchangeRoute,
  type Exchange,
  type ForwardFn,
} from "@routecraft/routecraft";
import type { BlockClient } from "./types.ts";

/**
 * Build the {@link BlockClient} handed to a block resolver function.
 *
 * Wraps the same {@link ForwardFn} that route `.error()` handlers
 * receive: resolves the dispatch's bound route via
 * `getExchangeRoute(exchange).getForward()`. When the exchange has no
 * route binding (synthetic exchanges in tests), `forward` rejects with
 * a clear error so a resolver does not silently no-op.
 *
 * @internal
 */
export function makeBlockClient(exchange: Exchange<unknown>): BlockClient {
  const route = getExchangeRoute(exchange);
  const forward: ForwardFn = route
    ? route.getForward()
    : async () => {
        throw new Error(
          "Block resolver: client.forward() called but the exchange has no bound route. " +
            "Block resolvers can only forward when invoked through a real route dispatch.",
        );
      };
  return { forward };
}
