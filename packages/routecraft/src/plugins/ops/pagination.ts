/**
 * Paging the management API's collections.
 *
 * Keyset cursors, matching `SuspensionStore.findExpired`'s idiom rather
 * than inventing a second one. The reason is not consistency for its own
 * sake: the collections this API will grow (parked suspensions, exchange
 * history) are live and mutating while an operator reads them, and offset
 * paging over a mutating set silently skips rows and repeats others. That
 * surfaces as "the console lost a parked payout", never as an error.
 *
 * A cursor is valid only for the filter that produced it, exactly as the
 * suspension store's cursor is valid only against the store that produced
 * it. Replaying one under a different filter would hand back a page from a
 * different result set with no way for the caller to notice, so it is
 * refused instead.
 */

import { rcError } from "../../error";
import type { OpsRouteFilter } from "./types";

/** Page size when the caller names none. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Largest page a caller may ask for. A bound rather than a preference: an
 * unbounded `limit` turns one request into an out-of-memory event.
 */
export const MAX_PAGE_SIZE = 200;

/** A decoded cursor: where to resume, and the filter it was minted under. */
interface DecodedCursor {
  after: string;
  filter: string;
}

/**
 * Canonical rendering of a filter, used to bind a cursor to it.
 *
 * Field order is fixed here rather than taken from the caller's query
 * string, so the same filter written two ways produces one fingerprint and
 * a cursor survives a client that reorders its parameters.
 */
export function fingerprintFilter(filter: OpsRouteFilter): string {
  return JSON.stringify([
    filter.dispatchable ?? null,
    filter.id ?? null,
    filter.source ?? null,
  ]);
}

/**
 * Reject a `limit` the API would otherwise have to guess at.
 *
 * Refused rather than clamped, as `assertSweepLimit` already does for the
 * suspension store: a caller that asked for 10000 and silently received 200
 * cannot tell a bounded page from a complete answer, and will read page one
 * forever believing it has everything.
 */
export function assertPageLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw rcError("RC5059", undefined, {
      message: `The page limit must be a positive integer; received ${String(limit)}.`,
    });
  }
  if (limit > MAX_PAGE_SIZE) {
    throw rcError("RC5059", undefined, {
      message: `The page limit must not exceed ${String(MAX_PAGE_SIZE)}; received ${String(limit)}.`,
    });
  }
}

/**
 * Mint a cursor pointing just past `lastId`, bound to the filter that
 * produced the page.
 *
 * Opaque to the caller by construction: base64url of a shape this module
 * owns. A client that decodes it and constructs its own is outside the
 * contract, which is the point of publishing a string rather than a key.
 */
export function encodeCursor(lastId: string, filter: OpsRouteFilter): string {
  const payload: DecodedCursor = {
    after: lastId,
    filter: fingerprintFilter(filter),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a cursor and check it was minted under this same filter.
 *
 * Both failure modes are the caller's, and they are deliberately one code
 * with different messages: a garbled cursor and a cursor replayed under a
 * changed filter are both "this cursor cannot be used here", and neither
 * says anything about the data behind it.
 */
export function decodeCursor(cursor: string, filter: OpsRouteFilter): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw rcError("RC5059", undefined, {
      message:
        "The cursor is malformed. Pass back the `nextCursor` from the previous page unchanged, or omit it to start from the first page.",
    });
  }
  const value = decoded as Partial<DecodedCursor> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.after !== "string" ||
    typeof value.filter !== "string"
  ) {
    throw rcError("RC5059", undefined, {
      message:
        "The cursor is malformed. Pass back the `nextCursor` from the previous page unchanged, or omit it to start from the first page.",
    });
  }
  if (value.filter !== fingerprintFilter(filter)) {
    throw rcError("RC5059", undefined, {
      message:
        "The cursor was produced under a different filter. A cursor pages one result set, so changing a filter starts a new listing: drop the cursor, or restore the filter it was issued under.",
    });
  }
  return value.after;
}

/**
 * Take one page from an id-ordered list.
 *
 * The list must already be sorted by `id` on the same strict total order
 * the cursor assumes; `compareRouteIds` is that order.
 */
export function takePage<T extends { id: string }>(
  sorted: readonly T[],
  filter: OpsRouteFilter,
  limit: number | undefined,
  after: string | undefined,
): { items: T[]; nextCursor?: string } {
  assertPageLimit(limit);
  const size = limit ?? DEFAULT_PAGE_SIZE;
  const start =
    after === undefined
      ? 0
      : sorted.findIndex((item) => compareRouteIds(item.id, after) > 0);
  // A cursor whose row has since disappeared is not an error: the next row
  // in order is exactly where the caller should resume, and findIndex
  // returning -1 means every remaining row sorts at or before it.
  if (start === -1) return { items: [] };
  const items = sorted.slice(start, start + size);
  const last = items[items.length - 1];
  const more = last !== undefined && start + size < sorted.length;
  return more
    ? { items, nextCursor: encodeCursor(last.id, filter) }
    : { items };
}

/**
 * Code-unit comparison, deliberately not `localeCompare`: the cursor needs
 * a stable strict order, and locale collation can change between runtimes.
 * The same reasoning as the suspension store's `compareIds`.
 */
export function compareRouteIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
