import { type Exchange } from "./exchange.ts";

export type Processor = {
  process(exchange: Exchange): Promise<Exchange> | Exchange;
};
