import { describe, expectTypeOf, test } from "bun:test";
import { craft, directory, only, simple } from "../src/index.ts";
import type { DirectoryEntry } from "../src/index.ts";
import { expectBodyOf } from "./helpers/types.ts";

/**
 * Type-level tests: a dynamic `path` on `directory()` reads the route body
 * the way `file()`'s and `http()`'s callbacks do (#727).
 */
describe("directory() type safety", () => {
  /**
   * @case A path callback in .enrich() reads the route body and the listing merges in
   * @preconditions from(simple({ dir })) then .enrich(directory({ path: (ex) => ex.body.dir }), only(..., 'entries'))
   * @expectedResult The callback sees { dir: string }; the body gains a DirectoryEntry[] `entries`
   */
  test("enrich(directory({ path: fn }), only()) types the callback", () => {
    const route = craft()
      .from(simple({ dir: "./inbox" }))
      .enrich(
        directory({
          path: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ dir: string }>();
            return exchange.body.dir;
          },
        }),
        only((entries: DirectoryEntry[]) => entries, "entries"),
      );
    expectBodyOf(route).toEqualTypeOf<
      { dir: string } & { entries: DirectoryEntry[] }
    >();
  });

  /**
   * @case A path callback in .to() reads the route body and the listing replaces it
   * @preconditions from(simple({ dir })) then .to(directory({ path: (ex) => ex.body.dir }))
   * @expectedResult The callback sees { dir: string }; there is no send, so the body becomes DirectoryEntry[]
   */
  test("to(directory({ path: fn })) types the callback and replaces the body", () => {
    const route = craft()
      .from(simple({ dir: "./inbox" }))
      .to(directory({ path: (exchange) => exchange.body.dir }));
    expectBodyOf(route).toEqualTypeOf<DirectoryEntry[]>();
  });
});
