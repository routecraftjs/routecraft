import type { CraftContext } from "./context.ts";
import type { Exchange, ExchangeHeaders } from "./exchange.ts";
import type { Source } from "./operations/from.ts";
import type { Destination } from "./operations/to.ts";
import {
  getAdapterFactory,
  getAdapterArgs,
  tagAdapter,
} from "./adapters/shared/factory-tag.ts";

/**
 * Store key under which test-time adapter overrides are registered.
 *
 * Intended for use by `@routecraft/testing`'s `testContext().override(...)`
 * API. Production code should not write to this key.
 * @internal
 */
export const RC_ADAPTER_OVERRIDES: unique symbol = Symbol.for(
  "routecraft.testing.adapter-overrides",
);

/**
 * Recorded call to an overridden destination adapter (send / enrich).
 * @internal
 */
export interface AdapterSendCall {
  /** Args that were passed to the adapter's factory at route definition time. */
  args: unknown[];
  /** Snapshot of the exchange as seen by the adapter at the moment of the call. */
  exchange: {
    id: string;
    body: unknown;
    headers: ExchangeHeaders;
  };
  /** Result the mock returned (undefined for void-returning sends). */
  result: unknown;
}

/**
 * Recorded call to an overridden source adapter (subscribe).
 * @internal
 */
export interface AdapterSourceCall {
  /** Args that were passed to the factory at route definition time. */
  args: unknown[];
  /** Number of messages yielded by this subscription. */
  yielded: number;
}

/**
 * Brand marking a source fixture that carries explicit headers alongside its
 * body. Lets a source-role mock reproduce the body/headers split that real
 * envelope-carrying sources (http, mail) perform, so a route that reads
 * `routecraft.<adapter>.*` headers can be exercised through `mockAdapter`.
 *
 * Use the `sourceMessage()` helper from `@routecraft/testing` to construct
 * these rather than building the branded object by hand.
 * @internal
 */
export const SOURCE_FIXTURE: unique symbol = Symbol.for(
  "routecraft.testing.source-fixture",
);

/**
 * A source fixture pairing a message body with the headers a real source would
 * have attached. Recognised by {@link wrapSourceWithOverride}.
 * @internal
 */
export interface SourceFixture<M = unknown> {
  readonly [SOURCE_FIXTURE]: true;
  /** The body the source would deliver on the exchange. */
  readonly body: M;
  /** Headers the source would attach (e.g. `routecraft.mail.*`). */
  readonly headers?: ExchangeHeaders;
}

/**
 * Type guard for {@link SourceFixture}. A plain message is delivered as the
 * body with no headers; a branded fixture is unwrapped into `(body, headers)`.
 * @internal
 */
export function isSourceFixture(value: unknown): value is SourceFixture {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SOURCE_FIXTURE]?: unknown })[SOURCE_FIXTURE] === true
  );
}

/**
 * A source-role fixture: either a plain message (delivered as the body with no
 * headers) or a {@link SourceFixture} carrying body + headers.
 * @internal
 */
export type SourceMessage<M = unknown> = M | SourceFixture<M>;

/**
 * Handler shape for a source-role mock. May be a plain array of fixtures,
 * an async iterable, or a callable that returns either (receiving the
 * construction args so it can vary by call site). Each fixture may be a plain
 * message or a {@link SourceFixture} (via `sourceMessage()`) to also attach
 * headers.
 * @internal
 */
export type SourceOverrideBehavior<M = unknown> =
  | readonly SourceMessage<M>[]
  | AsyncIterable<SourceMessage<M>>
  | Iterable<SourceMessage<M>>
  | ((
      args: unknown[],
    ) =>
      | readonly SourceMessage<M>[]
      | Iterable<SourceMessage<M>>
      | AsyncIterable<SourceMessage<M>>);

/**
 * Handler shape for a destination-role mock. Receives the exchange (as
 * seen by the adapter) and a meta object containing the factory args used
 * at the call site. Returning a value replaces `exchange.body` upstream.
 * @internal
 */
export type SendOverrideHandler = (
  exchange: Exchange,
  meta: { args: unknown[] },
) => unknown | Promise<unknown>;

/**
 * An override registered on a test context. `target` may be either the
 * factory function that produced the adapter (matched via the factory-tag
 * set by `tagAdapter`) or the adapter's constructor class (matched by
 * `adapter.constructor === target`). Both routes coexist so any adapter
 * can be mocked without opt-in, while tagged factories keep nicer DX.
 * @internal
 */
export interface AdapterOverride {
  /** Factory function or adapter class to match against the adapter instance. */
  target: unknown;
  /** Optional source-role behaviour (used when adapter has `subscribe`). */
  source?: SourceOverrideBehavior;
  /** Optional destination-role behaviour (used when adapter has `send`). */
  send?: SendOverrideHandler;
  /** Recorded calls, populated at execution time. */
  calls: {
    source: AdapterSourceCall[];
    send: AdapterSendCall[];
  };
}

/**
 * Take a defensive copy of an exchange body at call-recording time, so that
 * handlers mutating the body afterwards cannot corrupt the recorded snapshot.
 *
 * Uses `structuredClone` for plain values; falls back to the original
 * reference for values that cannot be cloned (functions, class instances
 * with unclonable internals, etc.) so recording never throws.
 */
function snapshotBody(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  try {
    return structuredClone(body);
  } catch {
    return body;
  }
}

/**
 * Look up an override registered on the given context for the adapter.
 * Matches by tagged factory first (if the adapter was stamped via
 * `tagAdapter`); falls back to matching by adapter constructor class so
 * any adapter can be mocked without opt-in tagging.
 *
 * @internal
 */
export function resolveAdapterOverride(
  adapter: unknown,
  context: CraftContext | undefined,
): AdapterOverride | undefined {
  if (!context) return undefined;
  const overrides = context.getStore(RC_ADAPTER_OVERRIDES);
  if (!overrides || overrides.length === 0) return undefined;
  const factory = getAdapterFactory(adapter);
  const ctor =
    adapter !== null && typeof adapter === "object"
      ? (adapter as { constructor?: unknown }).constructor
      : undefined;
  return overrides.find(
    (o) =>
      (factory !== undefined && o.target === factory) ||
      (ctor !== undefined && o.target === ctor),
  );
}

/**
 * Wrap a Source adapter so its `subscribe` is routed through the override's
 * `source` behaviour. The returned Source records calls on the override.
 *
 * If the override has no `source` behaviour, the original adapter is returned
 * unchanged (so that an override can stub only the destination side).
 *
 * @internal
 */
export function wrapSourceWithOverride<M = unknown>(
  adapter: Source<M>,
  override: AdapterOverride,
): Source<M> {
  if (!override.source) return adapter;
  const args = getAdapterArgs(adapter) ?? [];
  const behavior = override.source;

  // Preserve the prototype chain so `instanceof` and inherited methods keep
  // working on the wrapped source. Object.assign then copies the own
  // enumerable properties; the non-enumerable factory tags are re-applied
  // below so downstream tag lookups still resolve on the wrapper.
  const wrapped = Object.assign(
    Object.create(Object.getPrototypeOf(adapter) as object) as Source<M>,
    adapter as object,
  );
  const factory = getAdapterFactory(adapter);
  if (factory !== undefined) {
    tagAdapter(wrapped as object, factory, args);
  }

  wrapped.subscribe = async function subscribe(sub): Promise<void> {
    sub.ready();
    const record: AdapterSourceCall = { args, yielded: 0 };
    override.calls.source.push(record);

    const values = typeof behavior === "function" ? behavior(args) : behavior;

    // Dispatch all messages concurrently so `drain()` sees every handler
    // in-flight before the subscribe resolves. A sequential emit would
    // race against the drain/stop sequence and silently drop tail messages.
    const pending: Promise<void>[] = [];
    const dispatch = (message: unknown): void => {
      if (sub.signal.aborted) return;
      // A branded fixture carries its own headers (mirroring an
      // envelope-carrying source); a plain fixture is delivered as the body.
      const body = (isSourceFixture(message) ? message.body : message) as M;
      const headers = isSourceFixture(message) ? message.headers : undefined;
      pending.push(
        sub
          .emit({ message: body, ...(headers ? { headers } : {}) })
          .then(() => {
            record.yielded++;
          }),
      );
    };

    if (Array.isArray(values)) {
      for (const message of values) dispatch(message);
      await Promise.all(pending);
      return;
    }

    for await (const message of values as
      | Iterable<unknown>
      | AsyncIterable<unknown>) {
      if (sub.signal.aborted) break;
      dispatch(message);
    }
    await Promise.all(pending);
  };

  return wrapped;
}

/**
 * Invoke an overridden destination adapter and record the call.
 * Returns the mock's result (which the caller may use to replace the body).
 *
 * @internal
 */
export async function invokeSendOverride(
  exchange: Exchange,
  adapter: Destination<unknown, unknown>,
  override: AdapterOverride,
): Promise<unknown> {
  const args = getAdapterArgs(adapter) ?? [];
  const handler = override.send;

  const snapshot: AdapterSendCall["exchange"] = {
    id: exchange.id,
    body: snapshotBody(exchange.body),
    headers: { ...exchange.headers },
  };

  const record: AdapterSendCall = {
    args,
    exchange: snapshot,
    result: undefined,
  };
  override.calls.send.push(record);

  if (!handler) return undefined;

  // The call is already recorded above, so a rejection from `handler` still
  // shows up in `calls.send` (with `result` undefined) and then propagates
  // up the route pipeline the same way a real adapter failure would.
  const result = await Promise.resolve(handler(exchange, { args }));
  record.result = result;
  return result;
}
