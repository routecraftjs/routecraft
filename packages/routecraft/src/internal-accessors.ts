import { INTERNALS_KEY } from "./brand.ts";
import type { CraftContext } from "./context.ts";
import type { Exchange } from "./exchange.ts";
import type { Route } from "./route.ts";

type Slot = { readonly context?: CraftContext; readonly route?: Route };

/**
 * An exchange's internals as the `/internal` bundle can see them. That
 * bundle is a second copy of whatever it imports, so this reads the
 * symbol-keyed slot only, the one place an exchange built by the main
 * entry keeps its internals where another copy can reach them, and the
 * file imports nothing of the exchange module at runtime.
 */
function slotOf(exchange: Exchange): Slot | undefined {
  return (exchange as Exchange & { [INTERNALS_KEY]?: Slot })[INTERNALS_KEY];
}

/** @internal */
export function getExchangeContext(
  exchange: Exchange,
): CraftContext | undefined {
  return slotOf(exchange)?.context;
}

/** @internal */
export function getExchangeRoute(exchange: Exchange): Route | undefined {
  return slotOf(exchange)?.route;
}
