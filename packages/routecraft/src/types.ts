import { type Exchange, type ExchangeHeaders } from "./exchange.ts";
import { type OperationType } from "./exchange.ts";
import { CraftContext } from "./context.ts";
import { type RouteDefinition } from "./route.ts";

// eslint-disable-next-line
export interface Adapter {}

export interface StepDefinition<T extends Adapter> {
  operation: OperationType;
  adapter: T;

  execute(
    exchange: Exchange,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
  ): Promise<void>;
}

// MessageChannel lives with channel adapter now

export type ConsumerType<T extends Consumer, O = unknown> = new (
  context: CraftContext,
  definition: RouteDefinition,
  channel: unknown,
  options: O,
) => T;

export type Message = {
  message: unknown;
  headers?: ExchangeHeaders;
};

export interface Consumer<O = unknown> {
  context: CraftContext;
  channel: unknown; // will be narrowed by specific consumer types
  definition: RouteDefinition;
  options: O;
  register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): void;
}

// ProcessingQueue is an internal queue API for route source→consumer flow
export interface ProcessingQueue<T = unknown> {
  enqueue(message: T): Promise<void>;
  setHandler(handler: (message: T) => Promise<void>): Promise<void> | void;
  clear(): Promise<void> | void;
}
