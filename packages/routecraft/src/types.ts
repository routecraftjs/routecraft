import { type Exchange, type ExchangeHeaders } from "./exchange.ts";
import { type OperationType } from "./exchange.ts";
import { CraftContext } from "./context.ts";
import { type RouteDefinition } from "./route.ts";

export interface Binder {
  readonly type: string;
  readonly name: string;
}

export interface BinderSupport<TBinder extends Binder = Binder> {
  readonly binder: TBinder;
}

/**
 * Abstract base that provides binder plumbing with a default fallback.
 * Adapters that need a binder can extend this and implement defaultBinder().
 */
export abstract class BinderBackedAdapter<TBinder extends Binder>
  implements BinderSupport<TBinder>
{
  private _binder?: TBinder;

  setBinder(binder: TBinder): void {
    this._binder = binder;
  }

  get binder(): TBinder {
    return this._binder ?? this.defaultBinder();
  }

  /** Provide a sane default binder when none is registered/overridden */
  protected abstract defaultBinder(): TBinder;
}

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
