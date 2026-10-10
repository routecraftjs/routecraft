import { describe, expectTypeOf, test } from "bun:test";
import { craft, file, only, simple } from "../src/index.ts";
import type { FileAdapter } from "../src/index.ts";
import { expectBodyOf } from "./helpers/types.ts";

/**
 * Type-level tests: a dynamic `path` on `file()` reads the route body the
 * way `http()`'s `url` does, through `.to()` and `.enrich()` (#727).
 */
describe("file() type safety", () => {
  /**
   * @case A path callback in .to() reads the route body and the body flows on unchanged
   * @preconditions from(simple({ date })) then .to(file({ path: (ex) => ex.body.date })) with no type argument
   * @expectedResult The callback sees { date: string }; send wins, so the body stays { date: string }
   */
  test("to(file({ path: fn })) types the callback and keeps the body", () => {
    const route = craft()
      .from(simple({ date: "2026-10-10" }))
      .to(
        file({
          path: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ date: string }>();
            return `./data/${exchange.body.date}.txt`;
          },
        }),
      );
    expectBodyOf(route).toEqualTypeOf<{ date: string }>();
  });

  /**
   * @case A path callback in .enrich() reads the route body and the content merges in
   * @preconditions from(simple({ path })) then .enrich(file({ path: (ex) => ex.body.path }), only(..., 'content'))
   * @expectedResult The callback sees { path: string }; the body gains a string `content`
   */
  test("enrich(file({ path: fn }), only()) types the callback", () => {
    const route = craft()
      .from(simple({ path: "./a.txt" }))
      .enrich(
        file({
          path: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ path: string }>();
            return exchange.body.path;
          },
        }),
        only((content: string) => content, "content"),
      );
    expectBodyOf(route).toEqualTypeOf<{ path: string } & { content: string }>();
  });

  /**
   * @case The source role still emits a string body
   * @preconditions from(file({ path: './in.txt' }))
   * @expectedResult Body type is string regardless of the adapter's T
   */
  test("from(file()) emits a string body", () => {
    const route = craft().from(file({ path: "./in.txt" }));
    expectBodyOf(route).toEqualTypeOf<string>();
    expectTypeOf(file({ path: "./in.txt" })).toEqualTypeOf<
      FileAdapter<unknown>
    >();
  });

  /**
   * @case A function path has no source role
   * @preconditions file({ path: () => './in.txt' }) handed to .from()
   * @expectedResult A compile error: the overload a function path selects drops `subscribe`, so the mismatch the source refuses at start is caught by the compiler instead
   */
  test("from(file({ path: fn })) does not compile", () => {
    const dynamic = file({ path: () => "./in.txt" });
    expectTypeOf(dynamic).not.toHaveProperty("subscribe");
    // @ts-expect-error a source has no exchange to resolve a function path against
    craft().from(file({ path: () => "./in.txt" }));
  });
});
