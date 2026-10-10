import { expectTypeOf } from "bun:test";
import type { BodyOf } from "@routecraft/routecraft";

/**
 * `expectTypeOf` over the body a builder carries into its next step.
 *
 * A builder's own type also carries the application's installed plugins, so
 * a type-level test pins the body rather than the whole builder. Taking the
 * builder as a value lets a test assert on a chain it never runs: the
 * equivalent `expectTypeOf<BodyOf<typeof route>>()` leaves `route` bound but
 * only read as a type, which lint rejects as unused.
 *
 * @example
 * ```ts
 * const route = craft().from(simple({ id: 0 })).enrich(llm("ollama:x"));
 * expectBodyOf(route).toEqualTypeOf<LlmResult>();
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the argument exists only to infer B
export function expectBodyOf<B>(_builder: B) {
  return expectTypeOf<BodyOf<B>>();
}
