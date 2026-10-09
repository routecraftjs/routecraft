import { expectTypeOf } from "bun:test";
import type { BodyOf } from "../../src/index.ts";

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
 * const route = craft().from(simple({ id: 0 })).schema(nameSchema);
 * expectBodyOf(route).toEqualTypeOf<{ name: string }>();
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the argument exists only to infer B
export function expectBodyOf<B>(_builder: B) {
  return expectTypeOf<BodyOf<B>>();
}

/**
 * {@link expectBodyOf} for a builder a thunk would return, without calling it.
 *
 * For chains the runtime refuses to build (a multi-source `.from()` with no
 * `.input()` throws RC2001) but whose static type is still the subject.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the argument exists only to infer B
export function expectBodyReturnedBy<B>(_build: () => B) {
  return expectTypeOf<BodyOf<B>>();
}
