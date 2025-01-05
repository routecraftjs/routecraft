import { type Exchange, type ExchangeHeaders } from "@routecraft/core";

export interface Source {
  subscribe(
    receive: (message: unknown, headers?: ExchangeHeaders) => void,
  ): Promise<() => void>;
}

export interface Destination {
  send(exchange: Exchange): Promise<void>;
}

export interface Adapter extends Source, Destination {}
