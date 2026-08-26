import { z } from "zod";

/**
 * Trivial read-only fns used as registry fixtures by the selection,
 * defaults, runtime and bus-event suites. Those suites care about how a
 * registered fn is selected, defaulted, dispatched and reported, not about
 * what it computes, so they need a fn with a description, an empty input
 * schema and tags, and nothing more.
 *
 * One copy, because the suites assert on these tags and descriptions; a
 * drifted twin would let a selection regression hide in whichever suite
 * kept the stale copy.
 */
export const currentTimeFn = {
  description: "Returns the current UTC timestamp in ISO 8601 format.",
  input: z.object({}),
  handler: () => new Date().toISOString(),
  tags: ["read-only", "idempotent"],
};

/** Companion fixture giving the suites a second read-only fn to select between. */
export const randomUuidFn = {
  description: "Generates a fresh random UUID v4.",
  input: z.object({}),
  handler: () => crypto.randomUUID(),
  tags: ["read-only"],
};
