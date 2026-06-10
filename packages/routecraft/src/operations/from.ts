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
