import { type CraftContext } from "../context.ts";
import { type Exchange, type ExchangeHeaders } from "../exchange.ts";
import { type Adapter } from "../types.ts";

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
) => Promise<void> | void;

/**
 * Source adapter: produces messages for a route. Used with `.from(source)`.
 *
 * @template T - Body type of messages produced
 */
export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}
