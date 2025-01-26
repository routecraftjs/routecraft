import { type CraftContext, type Exchange } from "@routecraft/core";

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
