import { type CraftContext } from "../context.ts";
import { type Exchange, type ExchangeHeaders } from "../exchange.ts";
import { type RouteDiscovery } from "../route.ts";
import { type Adapter } from "../types.ts";

/**
 * Metadata the engine passes to a source adapter at subscribe time.
 *
 * Carries the route's id and optional discovery bundle so adapters that
 * maintain registries (direct, mcp) can mirror route-level metadata into
 * their own registry entries without re-declaring it in adapter options.
 * Optional at the type level so adapters that ignore it remain source-
 * compatible.
 */
export interface SourceMeta {
  /** ID of the route this source is subscribed to. */
  routeId: string;
  /** Route-level discovery bundle, when set via the builder. */
  discovery?: RouteDiscovery;
}

/**
 * Function form of a source: subscribes to data and invokes the handler for each message.
 * Use with `.from(callableSource)` or adapters that implement Source.
 *
 * @template T - Body type of messages produced by this source
 */
export type CallableSource<T = unknown> = (
  context: CraftContext,
  handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
  abortController: AbortController,
  onReady?: () => void,
  meta?: SourceMeta,
) => Promise<void> | void;

/**
 * Source adapter: produces messages for a route. Used with `.from(source)`.
 *
 * @template T - Body type of messages produced
 */
export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}
