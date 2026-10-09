import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ContextBuilder,
  craft,
  definePlugin,
  direct,
  noop,
  port,
  rcCodeOf,
  type Plugin,
} from "../src/index.ts";

async function refusal(plugins: Plugin[]): Promise<string | undefined> {
  try {
    await new ContextBuilder().with({ plugins }).build();
  } catch (error) {
    return rcCodeOf(error);
  }
  return undefined;
}

describe("hook precedence and declarations", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A plugin listed first requires a port the plugin listed second provides; both have a beforeAuth mutate hook writing one header
   * @preconditions The dependency makes the second plugin bind first
   * @expectedResult The hooks run in list order, so the second plugin's header value wins, as the plugin list reads
   */
  test("a dependency reorders binding and never a phase", async () => {
    const P = port<string>("test.precedence@1");
    const seen: string[] = [];
    const writer = (id: string, extra: Partial<Plugin>): Plugin => ({
      id,
      ...extra,
      hooks: {
        beforeAuth: {
          id: "write",
          phase: "mutate",
          run() {
            seen.push(id);
            return { headers: { winner: id } };
          },
        },
      },
    });
    const first = writer("test.first", {
      requires: [P],
      bind(c) {
        c.require(P);
      },
    });
    const second = writer("test.second", {
      provides: [P],
      bind(c) {
        c.provide(P, "x");
      },
    });
    let winner: unknown;
    t = await testContext()
      .with({ plugins: [first, second] })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .process((ex) => {
            winner = ex.headers["winner"];
            return ex;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("work", {});

    expect(seen).toEqual(["test.first", "test.second"]);
    expect(winner).toBe("test.second");
  });

  /**
   * @case One plugin declares a hook named "x" in beforeAuth and another named "x" in admitted
   * @preconditions Both are observe hooks
   * @expectedResult RC1112 at build naming both slots: a hook's name addresses one hook in hooks.order and hooks.disable
   */
  test("one hook name in two slots of one plugin is refused", async () => {
    const twice = definePlugin({
      id: "test.twice",
      hooks: {
        beforeAuth: { id: "x", phase: "observe", run() {} },
        admitted: { id: "x", phase: "observe", run() {} },
      },
    });

    expect(await refusal([twice])).toBe("RC1112");
  });

  /**
   * @case A hook declares runs with an entry that is not a run kind
   * @preconditions runs: ["normall"] on an exit hook
   * @expectedResult RC1115 at build: the hook would never run
   */
  test("an unknown run kind is refused", async () => {
    const typo = definePlugin({
      id: "test.typo",
      hooks: {
        exit: {
          id: "x",
          phase: "observe",
          runs: ["normall" as never],
          run() {},
        },
      },
    });

    expect(await refusal([typo])).toBe("RC1115");
  });
});
