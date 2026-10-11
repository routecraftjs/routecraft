import { describe, expect, test } from "bun:test";
import { ContextBuilder, craft, direct, noop } from "../src/index.ts";

const route = (id: string) => craft().id(id).from(direct()).to(noop());

describe("ContextBuilder.routes", () => {
  /**
   * @case Several routes passed as separate arguments are all registered
   * @preconditions Three builders passed to one routes() call, beside a list and a built definition in a second call
   * @expectedResult Every route is registered; none past the first argument is dropped, which is what an untyped caller would otherwise hit silently
   */
  test("registers every argument, lists and definitions included", async () => {
    const [built] = route("d").build();
    const { context } = await new ContextBuilder()
      .routes(route("a"), route("b"), route("c"))
      .routes([route("e"), built!], route("f"))
      .build();
    expect(context.getRoutes().map((r) => r.definition.id)).toEqual([
      "a",
      "b",
      "c",
      "e",
      "d",
      "f",
    ]);
  });
});
