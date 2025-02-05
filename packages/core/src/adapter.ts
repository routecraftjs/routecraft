import { type CraftContext } from "./context.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
} from "./exchange.ts";

export interface Adapter {
  readonly adapterId: string;
}

export type Source<T = unknown> = Adapter & {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void>;
};

export type Processor<T = unknown> = Adapter & {
  process(exchange: Exchange<T>): Promise<Exchange<T>> | Exchange<T>;
};

export type Destination<T = unknown> = Adapter & {
  send(exchange: Exchange<T>): Promise<void> | void;
};

export type Splitter<T = unknown, R = unknown> = Adapter & {
  split(exchange: Exchange<T>): Promise<Exchange<R>[]> | Exchange<R>[];
};

export type StepDefinition<
  T = unknown,
  K extends "from" | "to" | "process" | "split" =
    | "from"
    | "to"
    | "process"
    | "split",
> = {
  operation: OperationType;
} & (K extends "from"
  ? Source<T>
  : K extends "to"
    ? Destination<T>
    : K extends "process"
      ? Processor<T>
      : K extends "split"
        ? Splitter<T>
        : never);
