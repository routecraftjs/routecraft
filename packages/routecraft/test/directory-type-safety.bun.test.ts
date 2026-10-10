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
   * @expectedResult The callback sees { dir: string } rather than an untyped body; there is no send, so the body becomes DirectoryEntry[]
   */
  test("to(directory({ path: fn })) types the callback and replaces the body", () => {
    const route = craft()
      .from(simple({ dir: "./inbox" }))
      .to(
        directory({
          path: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ dir: string }>();
            return exchange.body.dir;
          },
        }),
      );
    expectBodyOf(route).toEqualTypeOf<DirectoryEntry[]>();
  });

  /**
   * @case A function path has no source role, chunked or not
   * @preconditions directory({ path: () => './inbox' }) and the same with chunked: true, each handed to .from()
   * @expectedResult A compile error for both: the overload a function path selects drops `subscribe`, so the mismatch the source refuses at start is caught by the compiler instead
   */
  test("from(directory({ path: fn })) does not compile", () => {
    expectTypeOf(directory({ path: () => "./inbox" })).not.toHaveProperty(
      "subscribe",
    );
    // @ts-expect-error a source has no exchange to resolve a function path against
    craft().from(directory({ path: () => "./inbox" }));
    // @ts-expect-error chunked is a source shape, and a function path has no source
    craft().from(directory({ path: () => "./inbox", chunked: true }));
  });
});
