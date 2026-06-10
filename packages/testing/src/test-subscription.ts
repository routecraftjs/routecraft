import type {
  CraftContext,
  Exchange,
  ExchangeHeaders,
  OnParseError,
  SourceMeta,
  Subscription,
} from "@routecraft/routecraft";

/**
 * Options for {@link testSubscription}. The `handler` mirrors the message
 * fields the engine receives, flattened into positional arguments so test
 * assertions read naturally.
 */
export interface TestSubscriptionOptions<T = unknown> {
  /** Context handed to the source (store access, logger). */
  context: CraftContext;
  /** Receives each emitted message; its return value resolves `emit`. */
  handler: (
    message: T,
    headers?: ExchangeHeaders,
    parse?: (raw: unknown) => unknown | Promise<unknown>,
    parseFailureMode?: OnParseError,
  ) => Promise<unknown> | unknown;
  /** Abort to stop the source; `complete()` calls its `abort`. */
  abortController?: AbortController;
  /** Called when the source signals readiness. */
  onReady?: () => void;
  /** Source meta; defaults to `{ routeId: "test" }`. */
  meta?: SourceMeta;
}

/**
 * Build a {@link Subscription} for driving a source adapter directly in a
 * unit test, without a running route. Wire-up mirrors the engine: `emit`
 * forwards to `handler`, `ready` to `onReady`, `complete` aborts the
 * controller, and `signal` observes it.
 *
 * @example
 * ```typescript
 * const received: unknown[] = [];
 * await adapter.subscribe(
 *   testSubscription({
 *     context: t.ctx,
 *     handler: (message) => void received.push(message),
 *     abortController,
 *   }),
 * );
 * ```
 */
export function testSubscription<T = unknown>(
  options: TestSubscriptionOptions<T>,
): Subscription<T> {
  const controller = options.abortController ?? new AbortController();
  return {
    context: options.context,
    signal: controller.signal,
    meta: options.meta ?? { routeId: "test" },
    ready: options.onReady ?? (() => {}),
    complete: (reason?: unknown) => controller.abort(reason),
    emit: async (msg) =>
      (await options.handler(
        msg.message,
        msg.headers,
        msg.parse,
        msg.parseFailureMode,
      )) as Exchange,
  };
}
