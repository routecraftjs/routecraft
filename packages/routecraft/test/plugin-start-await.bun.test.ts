import { describe, expect, test } from "bun:test";
import {
  ContextBuilder,
  craft,
  definePlugin,
  direct,
  noop,
  rcCodeOf,
} from "../src/index.ts";

describe("a lifecycle hook awaiting the start it is part of", () => {
  /**
   * @case A plugin's start hook awaits c.execution.whenStarted()
   * @preconditions One direct route
   * @expectedResult The start fails with RC1118 instead of waiting forever
   */
  test("from start is RC1118", async () => {
    const waiter = definePlugin({
      id: "test.waiter",
      async start(c) {
        await c.execution.whenStarted();
      },
    });
    const { context } = await new ContextBuilder()
      .with({ plugins: [waiter] })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    let thrown: unknown;
    try {
      await context.start();
    } catch (error) {
      thrown = error;
    } finally {
      await context.stop();
    }

    expect(rcCodeOf(thrown)).toBe("RC1118");
  });

  /**
   * @case A plugin's bind hook awaits c.execution.whenStarted()
   * @preconditions No routes
   * @expectedResult The build fails with RC1118
   */
  test("from bind is RC1118", async () => {
    const waiter = definePlugin({
      id: "test.waiter",
      async bind(c) {
        await c.execution.whenStarted();
      },
    });
    let thrown: unknown;
    try {
      await new ContextBuilder().with({ plugins: [waiter] }).build();
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC1118");
  });
});
