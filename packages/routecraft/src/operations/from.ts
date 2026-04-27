import { type CraftContext } from "../context.ts";
import { type Exchange, type ExchangeHeaders } from "../exchange.ts";
import { type RouteDiscovery } from "../route.ts";
import { type Adapter } from "../types.ts";
import { type OnParseError } from "../adapters/shared/parse.ts";

/**
 * Metadata the engine passes to a source adapter at subscribe time.
 *
 * Carries the route's id and optional discovery bundle so adapters that
 * maintain registries (direct, mcp) can mirror route-level metadata into
 * their own registry entries without re-declaring it in adapter options.
 * Optional at the type level so adapters that ignore it remain source-
 * compatible.
 */
export interface SourceMeta {
  /** ID of the route this source is subscribed to. */
  routeId: string;
  /** Route-level discovery bundle, when set via the builder. */
  discovery?: RouteDiscovery;
}

/**
 * Function form of a source: subscribes to data and invokes the handler for each message.
 * Use with `.from(callableSource)` or adapters that implement Source.
 *
 * The `handler` callback accepts an optional third argument, `parse`, that the
 * runtime invokes as a synthetic first pipeline step. Source adapters that
 * convert raw bytes into a structured body (json, html, csv, jsonl, mail) pass
 * their parse logic through this argument so a parse failure becomes a normal
 * pipeline error: the exchange exists, `exchange:started` has fired, and the
 * route's `.error()` handler can catch it. Adapters that emit pre-parsed
 * values (direct, simple, cron, timer, event, file) ignore the third argument.
 *
 * **Type caveat:** when `parse` is supplied, the `message` argument is the
 * RAW value (e.g. a JSON line string, raw RFC-822 bytes), not the typed `T`.
 * The exchange body is widened to `unknown` until the synthetic parse step
 * runs, then narrowed to `T` for downstream user steps. `.error()` handlers
 * tied to `Exchange<T>` should NOT assume the body is `T` when the failure
 * came from the parse step itself; they may be looking at raw bytes.
 *
 * @template T - Body type of messages produced by this source (after parse)
 */
export type CallableSource<T = unknown> = (
  context: CraftContext,
  handler: (
    message: T,
    headers?: ExchangeHeaders,
    /**
     * Optional parser invoked by the runtime as the first step of the
     * pipeline, before any user-defined step. The parsed result becomes the
     * exchange body. Errors thrown here flow through the route's normal
     * error handling: the route's `.error()` handler is invoked, or
     * `exchange:failed` fires when no handler is set. Source adapters use
     * this to defer parse failures so they are observable per exchange.
     *
     * Typed as `(raw: unknown) => unknown | Promise<unknown>` because the
     * runtime cannot statically know the parsed shape; adapters narrow at
     * the call site since they know their own raw and parsed types.
     *
     * @experimental Marked experimental until more parsing adapters adopt
     * the contract; see #187.
     */
    parse?: (raw: unknown) => unknown | Promise<unknown>,
    /**
     * Decides what the synthetic parse step does on failure:
     * - `"fail"` (default): throw `RC5016` so `exchange:failed` fires (or
     *   the route's `.error()` recovers it).
     * - `"abort"`: same lifecycle as `"fail"` but the source rethrows the
     *   rejection and dies (`context:error` fires).
     * - `"drop"`: emit `exchange:dropped` with `reason: "parse-failed"`
     *   instead of failing; the pipeline halts cleanly without invoking
     *   `.error()`.
     *
     * Adapters set this from their `onParseError` option.
     *
     * @experimental
     */
    parseFailureMode?: OnParseError,
  ) => Promise<Exchange>,
  abortController: AbortController,
  onReady?: () => void,
  meta?: SourceMeta,
) => Promise<void> | void;

/**
 * Source adapter: produces messages for a route. Used with `.from(source)`.
 *
 * @template T - Body type of messages produced
 */
export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}
