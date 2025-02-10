import { type CraftContext } from "../context.ts";
import { type ExchangeHeaders } from "../exchange.ts";
import { type Adapter } from "../types.ts";

export type CallableSource<T = unknown> = (
  context: CraftContext,
  handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
  abortController: AbortController,
) => Promise<void> | void;

export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}
