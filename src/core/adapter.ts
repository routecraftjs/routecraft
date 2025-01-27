import { type CraftContext } from "./context.ts";
import { type Exchange } from "./exchange.ts";

export type Message = Pick<Exchange, "body" | "headers">;

export interface Source {
  subscribe(
    context: CraftContext,
    handler: (exchange: Exchange) => void,
  ): Promise<() => void>;
}

export interface Destination {
  send(exchange: Exchange): Promise<void>;
}

export interface Adapter extends Source, Destination {}
