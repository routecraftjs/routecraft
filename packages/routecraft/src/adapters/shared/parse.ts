/**
 * How a source adapter handles a parse failure on an individual item.
 *
 * Source adapters that translate raw bytes into a structured body (json,
 * html, csv, jsonl, mail) accept this option to control what happens when
 * the parse step throws.
 *
 * All three modes are observable via the events bus, mirroring the
 * filter / validate operation patterns:
 *
 * | Mode    | Lifecycle events fired                       |
 * |---------|----------------------------------------------|
 * | `fail`  | `exchange:started` -> `exchange:failed` (or `error:caught` if `.error()` recovers) |
 * | `abort` | `exchange:started` -> `exchange:failed`, then `context:error` and the source dies |
 * | `drop`  | `exchange:started` -> `exchange:dropped` (`reason: "parse-failed"`) |
 *
 * @experimental The shape of this option may evolve as more parsing adapters
 * adopt the contract.
 */
export type OnParseError =
  /**
   * Default. The exchange fails: the route's `.error()` handler is invoked
   * with an `RC5016` error, or `exchange:failed` is emitted when no handler
   * is set. Streaming adapters continue to the next item.
   *
   * Use when you want parse failures to be observable per item and the rest
   * of the source to keep flowing.
   */
  | "fail"
  /**
   * The source aborts on the first parse failure. The bad item still emits
   * `exchange:started` -> `exchange:failed` for per-item observability;
   * then the source's subscribe promise rejects and `context:error` fires.
   *
   * Use when partial-data is unacceptable and a malformed item should stop
   * the import (atomic-load semantics).
   */
  | "abort"
  /**
   * The parse failure is dropped from the pipeline. The synthetic parse
   * step emits `exchange:started` -> `exchange:dropped` with
   * `reason: "parse-failed"` (matching `filter` / `validate` drop
   * semantics). Streaming adapters continue to the next item; no
   * `exchange:failed` and no `.error()` handler invocation.
   *
   * Use when malformed items are expected (scraping, lossy upstreams) and
   * you want them counted in `exchange:dropped` metrics rather than
   * surfaced as route errors.
   */
  | "drop";

/**
 * Default `OnParseError` value applied when a parsing adapter does not set
 * one explicitly.
 *
 * @experimental Tracks `OnParseError`'s maturity (#187).
 */
export const DEFAULT_ON_PARSE_ERROR: OnParseError = "fail";

/**
 * Reason string emitted on `exchange:dropped` when an `onParseError: 'drop'`
 * source rejects a malformed item. Stable so subscribers can filter:
 *
 * ```ts
 * ctx.on('route:*:exchange:dropped', ({ details }) => {
 *   if (details.reason === PARSE_DROPPED_REASON) metrics.increment('parse.dropped');
 * });
 * ```
 *
 * @experimental
 */
export const PARSE_DROPPED_REASON = "parse-failed";

/**
 * True if `err` is a Routecraft `RC5016` parse-failure error. Used by
 * source adapters in `'abort'` mode to discriminate between parse failures
 * (which should abort the source) and downstream pipeline failures
 * (destination errors, transform errors, etc.) that should NOT abort -
 * `'abort'` is documented as parse-specific behaviour.
 *
 * Mirrors the `isMailParseError` helper in the mail adapter.
 *
 * @experimental
 */
export function isParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5016"
  );
}
