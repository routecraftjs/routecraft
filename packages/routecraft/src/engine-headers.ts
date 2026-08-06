import { HeadersKeys } from "./exchange.ts";

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
 *
 * The rest of the reserved `routecraft.*` namespace (correlation id,
 * principal, adapter envelope keys) is deliberately settable: those keys are
 * documented inputs (e.g. addressing a mail operation via `MailHeaders.UID`),
 * and adapter receipt headers live there too.
 *
 * A `Map` (not an object literal) so user keys that collide with
 * `Object.prototype` members ("toString", "constructor", "__proto__", ...)
 * are never misread as engine-owned.
 *
 * Two callers enforce this from opposite ends: `.header()` rejects at
 * construction (RC5003), and the `.to()` receipt sink drops the write at
 * runtime with a warning (the send has already happened by then, so failing
 * the step would be worse than ignoring the header).
 *
 * @internal
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
