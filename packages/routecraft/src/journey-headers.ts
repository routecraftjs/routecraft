/**
 * The two engine-internal journey headers, in a module of their own so the
 * lineage index and the trace-context helpers can both read them without
 * importing each other.
 */

/**
 * Header that hands an adopted remote `traceparent` from a door to the
 * lineage index, and from there to `route:exchange:started` as
 * `remoteParent`, so a telemetry plugin makes the exchange span the remote
 * span's child. Kept only on the exchange the door built: a `direct()` call
 * from a live exchange drops it, since the caller's span is the callee's
 * parent, and only a route's ingress offers it to the lineage index, so a
 * continuation of the same exchange days later is a root of its own trace.
 * Engine-owned: `.header()` and mutate hooks are refused.
 *
 * @internal
 */
export const TRACE_PARENT_HEADER = "routecraft.trace.parent";

/**
 * Header marking an exchange that joined its journey rather than being
 * called into it, and how: `"door"` (a door adopted a caller's trace
 * context), `"correlate"` (`.correlate()` re-stamped the correlation id) or
 * `"event"` (an `event()` delivery continued the causing journey). It travels
 * with the exchange through `direct()`, `forward()` and a deferral, and the
 * lineage index carries the same fact through hand-offs that build a fresh
 * header bag. Engine-owned: `.header()` and mutate hooks are refused.
 *
 * @internal
 */
export const JOINED_HEADER = "routecraft.journey.joined";

/** `HeadersKeys.CAUSATION_ID`, spelled here so this module imports nothing. */
const CAUSATION_ID = "routecraft.causation_id";

/** What a root's lineage entry is built from, read off its headers. */
export interface JourneyOfHeaders {
  readonly causationId: string | undefined;
  readonly parentId: string | undefined;
  readonly joined: boolean;
  readonly remoteParent: string | undefined;
}

/**
 * Read a root exchange's place in its journey off its headers.
 *
 * The cause it reports is its causation id. Its in-process parent is the
 * same id, except where a door adopted the cause from a caller (the exchange
 * carries the adopted remote parent): an id from the wire may name any
 * exchange, so it never becomes a parent the `event()` guard walks.
 *
 * @param headers - The exchange's headers
 * @param ingress - Whether a route's ingress is entering it; only then is the adopted remote parent offered
 * @internal
 */
export function journeyOfHeaders(
  headers: Readonly<Record<string, unknown>>,
  ingress: boolean,
): JourneyOfHeaders {
  const cause = headers[CAUSATION_ID];
  const causationId = typeof cause === "string" ? cause : undefined;
  const parent = headers[TRACE_PARENT_HEADER];
  const adopted = typeof parent === "string";
  return {
    causationId,
    parentId: adopted ? undefined : causationId,
    joined: headers[JOINED_HEADER] !== undefined,
    remoteParent: ingress && adopted ? parent : undefined,
  };
}
