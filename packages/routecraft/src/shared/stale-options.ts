import { rcError } from "../error.ts";

/**
 * Reject options that no longer exist, so a stale name fails at build
 * rather than being ignored.
 *
 * TypeScript already refuses an unknown key, but only on an object literal.
 * A plain-JS caller, an `as any`, or an options object assembled elsewhere
 * and spread in gets no such check, and the option is simply dropped. A
 * timer that quietly keeps its 1000ms default because `intervalMs` no
 * longer means anything is a far worse failure than one that refuses to
 * build, so every removal is named here.
 *
 * Two kinds of staleness are caught. Any key ending in `Ms` is stale by
 * construction: authored time options take a {@link Duration} and carry no
 * unit suffix, so `Ms` on an authored option can only be a pre-0.7 name.
 * Anything else removed for its own reasons is listed per call site.
 *
 * @param options - The user-supplied options object, if any
 * @param surface - Call shape quoted in the error, e.g. `timer`
 * @param removed - Removed key mapped to the sentence saying what to write instead
 * @throws RC5003 naming the stale option and its replacement
 *
 * @internal
 */
export function rejectStaleOptions(
  options: unknown,
  surface: string,
  removed: Readonly<Record<string, string>> = {},
): void {
  if (typeof options !== "object" || options === null) return;

  for (const [key, guidance] of Object.entries(removed)) {
    // Own keys only, matching the Ms scan below. `in` would walk the
    // prototype chain and fail a build over a key the caller never wrote.
    if (Object.hasOwn(options, key)) {
      throw rcError("RC5003", undefined, {
        message: `${surface}({ ${key} }) was removed; ${guidance}`,
      });
    }
  }

  for (const key of Object.keys(options)) {
    if (/[a-z]Ms$/.test(key)) {
      throw rcError("RC5003", undefined, {
        message: `${surface}({ ${key} }) was renamed to ${surface}({ ${key.slice(0, -2)} }); authored time options take a Duration (a number of milliseconds, or a string such as "5m"), so the Ms suffix is gone.`,
      });
    }
  }
}
