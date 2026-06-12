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
 * Engine-owned headers `.header()` rejects up front, mapped to the
 * suggestion shown in the RC5003 error:
 *
 * - `routecraft.id`: `DefaultExchange.rewrap` unconditionally restores
 *   `prev.id` into the new headers, so a write would land in the merged
 *   record but be overwritten by the next rewrap, silently no-op-ing.
 * - `routecraft.operation`: rewritten by the engine before every step to
 *   reflect the current operation; a write is equally futile.
 * - `routecraft.route`: set at exchange construction; a write would
 *   persist but lie about which route owns the exchange.
 * - `routecraft.split_hierarchy`: maintained by split/aggregate to
 *   correlate children with their parent; a write corrupts joins.
 *
 * Rejecting at construction gives a clear message instead of a phantom
 * bug. The rest of the reserved `routecraft.*` namespace (correlation id,
 * principal, adapter envelope keys) is deliberately settable: those keys
 * are documented inputs (e.g. addressing a mail operation via
 * `MailHeaders.UID`). A `Map` (not an object literal) so user keys that
 * collide with `Object.prototype` members ("toString", "constructor",
 * "__proto__", ...) are never misread as engine-owned.
 */
const ENGINE_OWNED_HEADERS: ReadonlyMap<string, string> = new Map([
  [
    HeadersKeys.ID,
    "Identity is set once when the exchange is constructed and propagates automatically. If you need to correlate with an upstream id, use routecraft.correlation_id (settable via .header() or by source adapters).",
  ],
  [
    HeadersKeys.OPERATION,
    "The engine rewrites the operation header before every step; observe it via exchange.headers instead of setting it.",
  ],
  [
    HeadersKeys.ROUTE_ID,
    "The route id is bound when the exchange is constructed. To hand work to another route, use forward() or a direct() destination.",
  ],
  [
    HeadersKeys.SPLIT_HIERARCHY,
    "The split hierarchy is maintained by .split() / .aggregate(). To attach your own grouping metadata, use a custom header key.",
  ],
]);

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
    const suggestion = ENGINE_OWNED_HEADERS.get(key);
    if (suggestion !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `.header() cannot set "${key}": this header is framework-owned and maintained by the engine.`,
        suggestion,
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
