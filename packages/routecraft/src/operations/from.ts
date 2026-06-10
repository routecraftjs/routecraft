import { type CraftContext } from "../context.ts";
import { type Exchange } from "../exchange.ts";
import { type RouteDiscovery } from "../route.ts";
import { type Adapter, type Message } from "../types.ts";

/**
 * Metadata the engine passes to a source adapter at subscribe time.
 *
 * Carries the route's id and optional discovery bundle so adapters that
 * maintain registries (direct, mcp) can mirror route-level metadata into
 * their own registry entries without re-declaring it in adapter options.
 */
export interface SourceMeta {
  /** ID of the route this source is subscribed to. */
  routeId: string;
  /** Route-level discovery bundle, when set via the builder. */
  discovery?: RouteDiscovery;
}

/**
 * Everything a source adapter needs from the engine, handed to
 * {@link CallableSource} as a single object. Adding a capability to this
 * interface is additive; the source contract never changes shape again.
 *
 * Sources that authenticate at their boundary (e.g. the MCP server with
 * `auth:` configured) forward the resolved identity by writing the
 * structured `Principal` into `headers["routecraft.auth.principal"]`
 * on the emitted message: state lives on `headers`, full stop.
 *
 * @template T - Body type of messages produced by this source (after parse)
 */
export interface Subscription<T = unknown> {
  /** The owning context (store access, logger, events). */
  context: CraftContext;
  /** Fires when the route stops; sources must stop producing and return. */
  signal: AbortSignal;
  /** Route id and discovery bundle for registry-maintaining sources. */
  meta: SourceMeta;
  /**
   * Signal readiness: the source is wired and able to produce. Routes
   * emit `route:started` once every source has called this (emitting a
   * first message also marks readiness as a fallback).
   */
  ready(): void;
  /**
   * Signal that this finite source has finished producing. Aborts the
   * source's controller so a single-source route completes; on a
   * multi-ingress route only this source's child controller aborts.
   * Pass a reason to surface an abnormal completion.
   */
  complete(reason?: unknown): void;
  /**
   * Hand one message to the route. Resolves with the processed exchange
   * (or rejects with the pipeline error, which sources typically catch
   * and log so one bad message does not kill the source).
   *
   * The {@link Message} envelope carries the payload plus the optional
   * `parse` / `parseFailureMode` used by the synthetic parse step: when
   * `parse` is set, `message` is the RAW value (e.g. a JSON line string)
   * and the parsed result becomes the exchange body. See
   * `adapters/shared/parse.ts` for the `OnParseError` semantics.
   */
  emit(msg: Message<T>): Promise<Exchange>;
}

/**
 * Function form of a source: subscribes to data and emits messages until
 * the subscription's signal aborts. Use with `.from(callableSource)` or
 * adapters that implement {@link Source}.
 *
 * ```ts
 * .from(async (sub) => {
 *   while (!sub.signal.aborted) {
 *     const item = await poll();
 *     await sub.emit({ message: item, headers: { "x-origin": "poll" } });
 *   }
 * })
 * ```
 *
 * @template T - Body type of messages produced by this source (after parse)
 */
export type CallableSource<T = unknown> = (
  sub: Subscription<T>,
) => Promise<void> | void;

/**
 * Source adapter: produces messages for a route. Used with `.from(source)`.
 *
 * @template T - Body type of messages produced
 */
export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}

/**
 * Generator form of a source: an (async) generator function receiving the
 * {@link Subscription} and yielding message bodies. Each yielded value is
 * emitted sequentially (`await sub.emit(...)` per item, so the pipeline
 * applies natural backpressure); when the generator returns, the source
 * completes like any finite source. Use `sub.emit({ message, headers })`
 * directly inside the generator when a message needs headers.
 *
 * ```ts
 * .from(async function* (sub) {
 *   while (!sub.signal.aborted) {
 *     yield await poll();
 *   }
 * })
 * ```
 *
 * @template T - Body type of messages produced by this source
 */
export type GeneratorSource<T = unknown> = (
  sub: Subscription<T>,
) => AsyncGenerator<T, void, unknown> | Generator<T, void, unknown>;

/**
 * Anything `.from()` accepts and normalizes into a {@link Source}:
 * a Source adapter, a callable source, an (async) generator function,
 * or a bare (async) iterable of message bodies.
 *
 * @template T - Body type of messages produced
 */
export type SourceLike<T = unknown> =
  | Source<T>
  | CallableSource<T>
  | GeneratorSource<T>
  | AsyncIterable<T>
  | Iterable<T>;

const ASYNC_GENERATOR_CTOR = Object.getPrototypeOf(async function* () {})
  .constructor as object;
const GENERATOR_CTOR = Object.getPrototypeOf(function* () {})
  .constructor as object;

/** True when `value` is an (async) generator FUNCTION (not a running generator). */
function isGeneratorFunction(value: unknown): value is GeneratorSource {
  if (typeof value !== "function") return false;
  const ctor = (value as { constructor?: object }).constructor;
  return ctor === ASYNC_GENERATOR_CTOR || ctor === GENERATOR_CTOR;
}

/** True when `value` is a bare (async) iterable object (not a Source). */
function isIterableSource(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || typeof value !== "object") return false;
  if (typeof (value as Source).subscribe === "function") return false;
  const v = value as Record<symbol, unknown>;
  return (
    typeof v[Symbol.asyncIterator] === "function" ||
    typeof v[Symbol.iterator] === "function"
  );
}

/**
 * Normalize anything `.from()` accepts into a {@link Source}.
 *
 * Generator functions and bare iterables drive the subscription loop:
 * items are emitted sequentially, per-item pipeline failures are logged
 * at debug and do not stop iteration (matching `simple()`'s batch
 * semantics), and exhaustion completes the source.
 *
 * @internal Used by the route builder.
 */
export function toSource<T>(input: SourceLike<T>): Source<T> {
  if (typeof input === "function") {
    if (isGeneratorFunction(input)) {
      const generator = input as GeneratorSource<T>;
      return { subscribe: (sub) => drainIterable(sub, generator(sub)) };
    }
    return { subscribe: input as CallableSource<T> };
  }
  if (isIterableSource(input)) {
    const iterable = input as AsyncIterable<T>;
    return { subscribe: (sub) => drainIterable(sub, iterable) };
  }
  return input as Source<T>;
}

/** Shared loop for generator and iterable sources. */
async function drainIterable<T>(
  sub: Subscription<T>,
  iterable: AsyncIterable<T> | Iterable<T>,
): Promise<void> {
  sub.ready();
  let failCount = 0;
  try {
    for await (const item of iterable) {
      if (sub.signal.aborted) break;
      try {
        await sub.emit({ message: item });
      } catch {
        // Exchange error already logged by the route pipeline; keep
        // iterating so one bad item does not kill the source (matching
        // simple()'s array semantics).
        failCount++;
      }
    }
  } finally {
    if (failCount > 0) {
      sub.context.logger.warn(
        { adapter: "iterable", failCount },
        "Some exchanges from iterable source failed",
      );
    }
    sub.complete();
  }
}
