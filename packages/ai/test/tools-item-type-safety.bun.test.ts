import { describe, expectTypeOf, test } from "bun:test";
import { tools, type ToolsItem } from "../src/index.ts";

/**
 * Type-level tests: `background` on a `tools([...])` item is typed where it
 * applies, a `Direct(<routeId>)` binding, and nowhere else.
 */
describe("ToolsItem type safety", () => {
  /**
   * @case background is accepted on a Direct(...) binding and refused on any other name
   * @preconditions Items { name: "Direct(...)", background } and items naming a fn, an MCP tool, or a Remote(...) with background
   * @expectedResult The Direct items compile with either boolean; every other name with background is a compile error, while the same names without it still compile
   */
  test("background is typed on a Direct(...) name only", () => {
    const direct: ToolsItem = { name: "Direct(sandbox)", background: true };
    const remote: ToolsItem = {
      name: "Direct(lab:sandbox)",
      background: false,
    };
    const plain: ToolsItem = { name: "lookup", description: "a fn binding" };
    // @ts-expect-error background applies to a Direct(<routeId>) binding only
    const onFn: ToolsItem = { name: "lookup", background: true };
    // @ts-expect-error background applies to a Direct(<routeId>) binding only
    const onMcp: ToolsItem = { name: "mcp__fs__read", background: false };
    // @ts-expect-error background applies to a Direct(<routeId>) binding only
    const onRemote: ToolsItem = { name: "Remote(lab)", background: true };
    expectTypeOf(
      tools([direct, remote, plain, onFn, onMcp, onRemote]),
    ).toBeObject();
  });
});
