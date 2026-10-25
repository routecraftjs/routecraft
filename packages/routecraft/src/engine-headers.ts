import { HeadersKeys } from "./exchange.ts";
import { JOINED_HEADER, TRACE_PARENT_HEADER } from "./journey-headers.ts";

/**
 * Engine-owned headers, mapped to the remediation shown when something tries
 * to set one:
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
 * - `routecraft.correlation_id` and `routecraft.causation_id`: the logger
 *   bindings, the lifecycle events and the lineage index all read them, and a
 *   header write would move the header alone, leaving the rest on the old
 *   values with no record of the change. `.correlate()` re-stamps all of them
 *   together and emits `route:exchange:correlated`. A source adapter still
 *   supplies both on `emit`, since that is construction, not a write.
 * - `routecraft.trace.parent` and `routecraft.journey.joined`: what a door
 *   adopted from a caller, and whether the exchange's journey is a claim
 *   rather than an inheritance. A write could hand an exchange a remote
 *   parent no caller sent, or clear the mark that keeps a claimed
 *   correlation id from reaching a person's editor.
 *
 * The rest of the reserved `routecraft.*` namespace (principal, adapter
 * envelope keys) is deliberately settable: those keys are
 * documented inputs (e.g. addressing a mail operation via `MailHeaders.UID`),
 * and adapter receipt headers live there too.
 *
 * A `Map` (not an object literal) so user keys that collide with
 * `Object.prototype` members ("toString", "constructor", "__proto__", ...)
 * are never misread as engine-owned.
 *
 * Three callers enforce this: `.header()` rejects at construction (RC5003),
 * a plugin's mutate hook is refused when it runs (RC1115), and the `.to()`
 * receipt sink drops the write at runtime with a warning (the send has
 * already happened by then, so failing the step would be worse than
 * ignoring the header).
 *
 * @internal
 */
const ENGINE_OWNED_HEADERS: ReadonlyMap<string, string> = new Map([
  [
    HeadersKeys.ID,
    "Identity is set once when the exchange is constructed and propagates automatically. To join an exchange to an upstream journey, use .correlate(), or supply routecraft.correlation_id from a source adapter.",
  ],
  [
    HeadersKeys.CORRELATION_ID,
    "The correlation id is read by the logger, the lifecycle events and the lineage index, so a header write would move it alone. Use .correlate((exchange) => ({ correlationId })) to re-stamp it, or supply it from a source adapter's emit.",
  ],
  [
    HeadersKeys.CAUSATION_ID,
    "The engine sets the causation id at every hand-off. Use .correlate((exchange) => ({ causationId })) to point an exchange at the one that caused it, or supply it from a source adapter's emit.",
  ],
  [
    TRACE_PARENT_HEADER,
    "A door sets the remote trace parent when it adopts a caller's trace context; configure the door's traceContext option instead.",
  ],
  [
    JOINED_HEADER,
    "The engine marks an exchange that joined its journey (a door adopted it, .correlate() re-stamped it, or an event() delivery continued it); it cannot be set or cleared by hand.",
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
 * Remediation text for an engine-owned header key, or `undefined` when the key
 * is free to set.
 *
 * @param key - Header key to test
 * @returns Suggestion to show the caller, or `undefined` when the key is settable
 * @internal
 */
export function engineOwnedHeaderSuggestion(key: string): string | undefined {
  return ENGINE_OWNED_HEADERS.get(key);
}
