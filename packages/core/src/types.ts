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

export type ChannelType<T extends MessageChannel> = new (channel: string) => T;

export interface MessageChannel<T = unknown> {
  /** Send a message to the channel */
  send(channel: string, message: T): Promise<void>;

  /** Subscribe to a channel */
  subscribe(
    context: CraftContext,
    channel: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void>;

  /** Unsubscribe from a channel */
  unsubscribe(context: CraftContext, channel: string): Promise<void>;
}

export type ConsumerType<T extends Consumer, O = unknown> = new (
  context: CraftContext,
  definition: RouteDefinition,
  channel: MessageChannel<Message>,
  options: O,
) => T;

export type Message = {
  message: unknown;
  headers?: ExchangeHeaders;
};

export interface Consumer<O = unknown> {
  context: CraftContext;
  channel: MessageChannel<Message>;
  definition: RouteDefinition;
  options: O;
  register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): void;
}
