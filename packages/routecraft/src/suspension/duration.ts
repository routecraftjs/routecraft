import { rcError } from "../error.ts";

/**
 * How long a suspension stays resumable: milliseconds, or a duration
 * string with a unit suffix (`"500ms"`, `"30s"`, `"15m"`, `"72h"`, `"7d"`).
 *
 * The string form exists because the realistic values here are human ones:
 * an approval window is three days, not 259_200_000.
 */
export type Duration = number | `${number}${DurationUnit}`;

/** Unit suffixes accepted by {@link parseDuration}. */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d";

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Anchored, and the unit is required: "72" would otherwise be ambiguous
// between 72ms (the numeric form's unit) and the 72 hours the author meant.
const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/**
 * Resolve a {@link Duration} to milliseconds.
 *
 * Exported so application code (a harness, a config loader, a route that
 * computes a ttl) can validate a duration under exactly the rules the
 * suspend surfaces apply, instead of re-implementing the grammar and
 * drifting from it.
 *
 * @param value - Milliseconds, or a duration string
 * @param field - Option name quoted in the error message
 * @returns The duration in milliseconds
 * @throws RC5003 when the value is not a duration an `expiresAt` `Date`
 *   can represent: at least one millisecond, and not past the end of the
 *   representable time range
 */
export function parseDuration(value: Duration, field: string): number {
  if (typeof value === "number") return assertRepresentable(value, field);
  // Narrowed before `.trim()`: `ttl` crosses a plain-JavaScript boundary,
  // where `null`, a boolean or an object would otherwise raise a native
  // TypeError instead of the RC5003 this function documents.
  if (typeof value !== "string") {
    throw refuse(
      field,
      typeof value === "object" ? "an object" : String(value),
    );
  }
  const match = PATTERN.exec(value.trim());
  if (!match) throw refuse(field, value);
  return assertRepresentable(
    Number(match[1]) * UNIT_MS[match[2] as DurationUnit],
    field,
  );
}

/**
 * Bound a duration to what an `expiresAt` `Date` can actually hold.
 *
 * Both ends matter and both fail late without this. Below a millisecond
 * the deadline rounds to the moment of parking, so the suspension expires
 * on arrival; beyond the Date range the arithmetic yields an Invalid Date
 * that is only discovered once the record is already in the store, where
 * every comparison against it is false.
 *
 * @internal
 */
function assertRepresentable(ms: number, field: string): number {
  if (!Number.isFinite(ms) || ms < 1) throw refuse(field, String(ms));
  // ECMAScript pins the time value range at +/- 8.64e15 ms from the epoch;
  // a TTL is added to "now", so the ceiling is what is left of it.
  if (Date.now() + ms > 8.64e15) throw refuse(field, String(ms));
  return Math.floor(ms);
}

/** @internal */
function refuse(field: string, value: string): Error {
  return rcError("RC5003", undefined, {
    message: `${field} must be a positive number of milliseconds or a duration string like "30s", "15m", "72h" or "7d"; received ${JSON.stringify(value)}.`,
  });
}
