import { describe, expect, test } from "bun:test";
import {
  ContextBuilder,
  definePlugin,
  port,
  rcCodeOf,
  type Plugin,
} from "../src/index.ts";

async function refusal(plugins: Plugin[]): Promise<unknown> {
  try {
    await new ContextBuilder().with({ plugins }).build();
  } catch (error) {
    return error;
  }
  throw new Error("the build did not refuse");
}

describe("the kernel host: provisions and ids", () => {
  /**
   * @case A provider calls c.provide(port, undefined)
   * @preconditions The port is declared in provides
   * @expectedResult RC1109: a consumer's require() would hand out nothing
   */
  test("providing undefined is refused", async () => {
    const P = port<string | undefined>("test.undefined@1");
    const error = await refusal([
      definePlugin({
        id: "test.provider",
        provides: [P],
        bind(c) {
          c.provide(P, undefined);
        },
      }),
    ]);

    expect(rcCodeOf(error)).toBe("RC1109");
    expect(String(error)).toContain("undefined");
  });

  /**
   * @case A provider calls c.provide() twice for one port
   * @preconditions Both calls in bind, with different values
   * @expectedResult RC1109 at the second call; a port is provided once
   */
  test("providing twice is refused", async () => {
    const P = port<number>("test.twice@1");
    const error = await refusal([
      definePlugin({
        id: "test.provider",
        provides: [P],
        bind(c) {
          c.provide(P, 1);
          c.provide(P, 2);
        },
      }),
    ]);

    expect(rcCodeOf(error)).toBe("RC1109");
    expect(String(error)).toContain("twice");
  });

  /**
   * @case A plugin id carries the host's own separators
   * @preconditions "test.rep#1" and "test.plugin/hook" as ids
   * @expectedResult RC1117 for each, naming the character set an id may use
   */
  test("an id with a separator the host owns is refused", async () => {
    for (const id of ["test.rep#1", "test.plugin/hook", "test plugin"]) {
      const error = await refusal([definePlugin({ id })]);
      expect([id, rcCodeOf(error)]).toEqual([id, "RC1117"]);
    }
  });
});
