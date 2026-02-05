import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType, type HeaderValue } from "../exchange.ts";

/**
 * Header: set or override a single exchange header.
 * - Returns the same body; only headers are changed
 * - Prefer this over `.process` when only a header needs updating
 */

export type CallableHeaderSetter<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<HeaderValue> | HeaderValue;

export interface HeaderSetter<T = unknown> extends Adapter {
  /** Header key to set */
  key: string;
  /** Function that computes the header value from exchange data */
  set: CallableHeaderSetter<T>;
}

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
