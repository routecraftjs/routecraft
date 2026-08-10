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
 * @param value - Milliseconds, or a duration string
 * @param field - Option name quoted in the error message
 * @returns The duration in milliseconds
 * @throws RC5003 when the value is not a positive finite duration
 *
 * @internal
 */
export function parseDuration(value: Duration, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw refuse(field, String(value));
    }
    return value;
  }
  const match = PATTERN.exec(value.trim());
  if (!match) throw refuse(field, value);
  const amount = Number(match[1]);
  const unit = match[2] as DurationUnit;
  const ms = amount * UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) throw refuse(field, value);
  return ms;
}

/** @internal */
function refuse(field: string, value: string): Error {
  return rcError("RC5003", undefined, {
    message: `${field} must be a positive number of milliseconds or a duration string like "30s", "15m", "72h" or "7d"; received ${JSON.stringify(value)}.`,
  });
}
