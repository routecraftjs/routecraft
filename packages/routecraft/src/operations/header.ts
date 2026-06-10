import { type Adapter, type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  type HeaderValue,
  type HeaderLiteral,
  DefaultExchange,
  HeadersKeys,
} from "../exchange.ts";
import { rcError } from "../error.ts";

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
    setterOrValue: CallableHeaderSetter<T> | HeaderLiteral,
  ) {
    // Exchange identity is framework-owned: `DefaultExchange.rewrap`
    // unconditionally restores `prev.id` into the new headers so identity
    // is preserved across every pipeline step. A `.header()` write of
    // `routecraft.id` would land in the merged record but be overwritten
    // by the next rewrap, silently no-op-ing. Reject up front with a
    // clear message rather than letting the user chase a phantom bug.
    if (key === HeadersKeys.ID) {
      throw rcError("RC5003", undefined, {
        message: `.header() cannot set "${HeadersKeys.ID}": exchange identity is framework-owned and preserved across every rewrap.`,
        suggestion:
          "Identity is set once when the exchange is constructed and propagates automatically. If you need to correlate with an upstream id, use routecraft.correlation_id (settable via .header() or by source adapters).",
      });
    }

    const set: CallableHeaderSetter<T> =
      typeof setterOrValue === "function"
        ? (setterOrValue as CallableHeaderSetter<T>)
        : () => setterOrValue;

    this.adapter = { key, set };
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const value = await Promise.resolve(this.adapter.set(exchange));
    const next = DefaultExchange.rewrap<T>(exchange, {
      headers: { ...exchange.headers, [this.adapter.key]: value },
    });
    return { kind: "continue", exchange: next };
  }
}
