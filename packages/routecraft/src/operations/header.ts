import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType, type HeaderValue } from "../exchange.ts";

/**
 * Function that returns the value for a header. Can be async. Use with `.header(key, valueOrFn)`.
 *
 * @template T - Body type of the exchange
 */
export type CallableHeaderSetter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<HeaderValue> | HeaderValue;

/**
 * Header setter adapter: sets or overrides one exchange header. Body is unchanged.
 * Used by the builder's `.header(key, valueOrFn)`.
 *
 * @template T - Body type
 */
export interface HeaderSetter<T = unknown> extends Adapter {
  /** Header key to set (e.g. `x-request-id`, `routecraft.custom`) */
  key: string;
  /** Computes the header value from the exchange (or static value via wrapper) */
  set: CallableHeaderSetter<T>;
}

/**
 * Step that sets or overrides a single header on the exchange. Body type is unchanged.
 */
export class HeaderStep<T = unknown> implements Step<HeaderSetter<T>> {
  operation: OperationType = OperationType.HEADER;
  adapter: HeaderSetter<T>;

  constructor(
    key: string,
    setterOrValue: CallableHeaderSetter<T> | HeaderValue,
  ) {
    const set: CallableHeaderSetter<T> =
      typeof setterOrValue === "function"
        ? (setterOrValue as CallableHeaderSetter<T>)
        : () => setterOrValue;

    this.adapter = { key, set };
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const value = await Promise.resolve(this.adapter.set(exchange));
    exchange.headers[this.adapter.key] = value;
    queue.push({ exchange, steps: remainingSteps });
  }
}
