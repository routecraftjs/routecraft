import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ContextBuilder,
  craft,
  definePlugin,
  direct,
  noop,
  OperationType,
  rcCodeOf,
  step,
  type RouteView,
} from "../src/index.ts";

describe("the route view a plugin reads", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case A plugin's start hook appends a step to a route through c.routes.get(id).definition.steps
   * @preconditions The application has frozen and compiled the route
   * @expectedResult The write is refused with RC1110, so the start fails, and the step list the plugin read is read-only at the type too
   */
  test("refuses a write to the step list", async () => {
    let refused: unknown;
    const editor = definePlugin({
      id: "test.editor",
      start(c) {
        const route = c.routes.get("view")!;
        try {
          // @ts-expect-error the view's step list is read-only; this is the runtime half of that
          route.definition.steps.push(step(() => "changed"));
        } catch (error) {
          refused = error;
          throw error;
        }
      },
    });
    t = await testContext()
      .with({ plugins: [editor] })
      .routes([
        craft()
          .id("view")
          .from(direct())
          .transform(() => "original")
          .to(noop()),
      ])
      .build();
    let startFailure: unknown;
    try {
      await t.startAndWaitReady();
    } catch (error) {
      startFailure = error;
    }

    expect(rcCodeOf(refused)).toBe("RC1110");
    expect(rcCodeOf(startFailure)).toBe("RC1110");
  });

  /**
   * @case A plugin's bind hook replaces a field of another plugin's registered route through the view
   * @preconditions The route is registered by an earlier plugin's bind
   * @expectedResult RC1110 at build: the view is read-only before the freeze as well, since registering is the way a plugin contributes a route
   */
  test("refuses a write to a field before the freeze", async () => {
    const registrar = definePlugin({
      id: "test.registrar",
      bind(c) {
        c.routes.register(
          craft().id("owned").from(direct()).to(noop()).build()[0]!,
        );
      },
    });
    const editor = definePlugin({
      id: "test.editor",
      bind(c) {
        const view = c.routes.get("owned")!;
        (view.definition as { id: string }).id = "renamed";
      },
    });
    let thrown: unknown;
    try {
      await new ContextBuilder().with({ plugins: [registrar, editor] }).build();
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC1110");
  });

  /**
   * @case A plugin reads a route through the view
   * @preconditions One route with two steps
   * @expectedResult The definition reads as the live one: the id, the step count and each step's operation, and the view is stable across reads
   */
  test("reads the live definition", async () => {
    let seen: RouteView | undefined;
    let again: RouteView | undefined;
    const reader = definePlugin({
      id: "test.reader",
      start(c) {
        seen = c.routes.get("view");
        again = c.routes.get("view");
      },
    });
    t = await testContext()
      .with({ plugins: [reader] })
      .routes([
        craft()
          .id("view")
          .from(direct())
          .transform(() => "original")
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(seen?.definition.id).toBe("view");
    expect(seen?.definition.steps.length).toBe(2);
    expect(seen?.definition.steps.map((s) => s.operation)).toEqual([
      OperationType.TRANSFORM,
      OperationType.TO,
    ]);
    expect(seen?.definition).toBe(again?.definition);
  });
});
