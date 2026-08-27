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
 * The single duration guard for the whole framework: every authored time
 * option parses here, so the accepted grammar cannot drift between the
 * surfaces that use it.
 *
 * @param value - Milliseconds, or a duration string
 * @param field - Option name quoted in the error message
 * @param min - Smallest accepted duration. `1` (the default) for a
 *   deadline, where zero means "already expired" and is always a mistake;
 *   `0` for a wait, where zero legitimately means "do not wait".
 * @returns The duration in milliseconds
 * @throws RC5003 when the value is not a duration an `expiresAt` `Date`
 *   can represent: at least `min` milliseconds, and not past the end of
 *   the representable time range
 */
export function parseDuration(
  value: Duration,
  field: string,
  min: 0 | 1 = 1,
): number {
  if (typeof value === "number") return assertRepresentable(value, field, min);
  // Narrowed before `.trim()`: `ttl` crosses a plain-JavaScript boundary,
  // where `null`, a boolean or an object would otherwise raise a native
  // TypeError instead of the RC5003 this function documents.
  if (typeof value !== "string") {
    throw refuse(
      field,
      typeof value === "object" ? "an object" : String(value),
      min,
    );
  }
  const match = PATTERN.exec(value.trim());
  if (!match) throw refuse(field, value, min);
  return assertRepresentable(
    Number(match[1]) * UNIT_MS[match[2] as DurationUnit],
    field,
    min,
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
function assertRepresentable(ms: number, field: string, min: 0 | 1): number {
  if (!Number.isFinite(ms) || ms < min) throw refuse(field, String(ms), min);
  // ECMAScript pins the time value range at +/- 8.64e15 ms from the epoch;
  // a TTL is added to "now", so the ceiling is what is left of it.
  if (Date.now() + ms > 8.64e15) throw refuse(field, String(ms), min);
  return Math.floor(ms);
}

/** @internal */
function refuse(field: string, value: string, min: 0 | 1): Error {
  const floor = min === 0 ? "a non-negative" : "a positive";
  return rcError("RC5003", undefined, {
    message: `${field} must be ${floor} number of milliseconds or a duration string like "30s", "15m", "72h" or "7d"; received ${JSON.stringify(value)}.`,
  });
}
