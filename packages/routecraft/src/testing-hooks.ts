import type { CraftContext } from "./context.ts";
import type { Exchange, ExchangeHeaders } from "./exchange.ts";
import type { Source } from "./operations/from.ts";
import type { Destination } from "./operations/to.ts";
import {
  getAdapterFactory,
  getAdapterArgs,
} from "./adapters/shared/factory-tag.ts";

/**
 * Store key under which test-time adapter overrides are registered.
 *
 * Intended for use by `@routecraft/testing`'s `testContext().override(...)`
 * API. Production code should not write to this key.
 *
 * @internal
 */
export const RC_ADAPTER_OVERRIDES: unique symbol = Symbol.for(
  "routecraft.testing.adapter-overrides",
);

/**
 * Recorded call to an overridden destination adapter (send / enrich).
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
 */
export interface AdapterSourceCall {
  /** Args that were passed to the factory at route definition time. */
  args: unknown[];
  /** Number of messages yielded by this subscription. */
  yielded: number;
}

/**
 * Handler shape for a source-role mock. May be a plain array of fixtures,
 * an async iterable, or a callable that returns either (receiving the
 * construction args so it can vary by call site).
 */
export type SourceOverrideBehavior<M = unknown> =
  | readonly M[]
  | AsyncIterable<M>
  | Iterable<M>
  | ((args: unknown[]) => readonly M[] | Iterable<M> | AsyncIterable<M>);

/**
 * Handler shape for a destination-role mock. Receives the exchange (as
 * seen by the adapter) and a meta object containing the factory args used
 * at the call site. Returning a value replaces `exchange.body` upstream.
 */
export type SendOverrideHandler = (
  exchange: Exchange,
  meta: { args: unknown[] },
) => unknown | Promise<unknown>;

/**
 * An override registered on a test context. Matches adapter instances that
 * share `factory`; provides source/send behaviour and records calls.
 *
 * @internal
 */
export interface AdapterOverride {
  /** Factory reference that tagged adapters are matched against. */
  factory: unknown;
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
 * Look up an override registered on the given context for the adapter.
 *
 * @internal
 */
export function resolveAdapterOverride(
  adapter: unknown,
  context: CraftContext | undefined,
): AdapterOverride | undefined {
  if (!context) return undefined;
  const factory = getAdapterFactory(adapter);
  if (!factory) return undefined;
  const overrides = context.getStore(RC_ADAPTER_OVERRIDES);
  if (!overrides) return undefined;
  return overrides.find((o) => o.factory === factory);
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

  const wrapped: Source<M> = {
    ...(adapter as object),
    async subscribe(
      _context,
      handler,
      abortController,
      onReady,
    ): Promise<void> {
      onReady?.();
      const record: AdapterSourceCall = { args, yielded: 0 };
      override.calls.source.push(record);

      const values = typeof behavior === "function" ? behavior(args) : behavior;

      const iterate = async (
        iterable: Iterable<unknown> | AsyncIterable<unknown>,
      ): Promise<void> => {
        for await (const message of iterable as AsyncIterable<unknown>) {
          if (abortController.signal.aborted) return;
          await handler(message as M);
          record.yielded++;
        }
      };

      if (Array.isArray(values)) {
        for (const message of values) {
          if (abortController.signal.aborted) return;
          await handler(message as M);
          record.yielded++;
        }
        return;
      }

      await iterate(values as Iterable<unknown> | AsyncIterable<unknown>);
    },
  } as Source<M>;

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
    body: exchange.body,
    headers: { ...exchange.headers },
  };

  const record: AdapterSendCall = {
    args,
    exchange: snapshot,
    result: undefined,
  };
  override.calls.send.push(record);

  if (!handler) return undefined;

  // Record the call first so failed invocations are still observable; then
  // rethrow so the route pipeline surfaces the error the same way it would
  // if the real adapter had thrown.
  const result = await Promise.resolve(handler(exchange, { args }));
  record.result = result;
  return result;
}
