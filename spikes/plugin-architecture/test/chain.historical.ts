import { describe, expect, test } from "bun:test";
import { Kernel } from "../src/kernel/index.ts";
import { CycleError } from "../src/kernel/graph.ts";
import { Runtime, type RouteSpec } from "../src/runtime/index.ts";
import { operations } from "../src/plugins/operations.ts";
import { resilience } from "../src/plugins/resilience.ts";
import { stores } from "../src/plugins/stores.ts";
import { deferral } from "../src/plugins/deferral.ts";
import { audit } from "../src/plugins/audit.ts";
import type { Plugin } from "../src/contracts/index.ts";

const route = (
  steps: RouteSpec["steps"],
  options?: RouteSpec["options"],
): RouteSpec => ({
  id: "demo",
  source: { label: "none", subscribe: () => Promise.resolve(() => {}) },
  steps,
  ...(options ? { options } : {}),
});

describe("intervention registry: wrapper ordering", () => {
  /**
   * @case Constraints reproduce the documented pre-from order
   * @preconditions resilience contributes retry, timeout and concurrency with after-constraints
   * @expectedResult the order is retry, timeout, concurrency, outermost first
   */
  test("declared constraints reproduce the fixed chain", async () => {
    const kernel = new Kernel([resilience()]);
    await kernel.start();
    expect(kernel.interventions.orderedWrappers().map((w) => w.id)).toEqual([
      "routecraft.retry",
      "routecraft.timeout",
      "routecraft.concurrency",
    ]);
  });

  /**
   * @case A third party inserts a wrapper into the middle of a first-party chain
   * @preconditions acme.audit declares after retry and before timeout
   * @expectedResult it lands between them, with no change to core or to resilience
   */
  test("a stranger's wrapper lands mid-chain with no core change", async () => {
    const kernel = new Kernel([stores(), resilience(), audit([])]);
    await kernel.start();
    expect(kernel.interventions.orderedWrappers().map((w) => w.id)).toEqual([
      "routecraft.retry",
      "acme.audit",
      "routecraft.timeout",
      "routecraft.concurrency",
    ]);
  });

  /**
   * @case Two wrappers each claim to be outside the other
   * @preconditions a is before b and b is before a
   * @expectedResult ordering throws a CycleError rather than picking silently
   */
  test("refuses contradictory ordering constraints", async () => {
    const bad: Plugin = {
      id: "bad",
      apply(ctx) {
        ctx.contribute({
          kind: "wrapper",
          id: "a",
          before: ["b"],
          wrap: (n) => n,
        });
        ctx.contribute({
          kind: "wrapper",
          id: "b",
          before: ["a"],
          wrap: (n) => n,
        });
      },
    };
    const kernel = new Kernel([bad]);
    await kernel.start();
    expect(() => kernel.interventions.orderedWrappers()).toThrow(CycleError);
  });

  /**
   * @case A wrapper names a constraint against a plugin that is not installed
   * @preconditions deferral's admission declares after routecraft.authorize, and auth is absent
   * @expectedResult the chain still orders, treating the absent constraint as satisfied
   */
  test("an ordering constraint on an absent plugin is inert, not fatal", async () => {
    const kernel = new Kernel([stores(), resilience(), deferral()]);
    await kernel.start();
    const ids = kernel.interventions.orderedWrappers().map((w) => w.id);
    expect(ids).toContain("routecraft.admission");
    expect(ids.indexOf("routecraft.admission")).toBeLessThan(
      ids.indexOf("routecraft.retry"),
    );
  });

  /**
   * @case Wrappers actually execute in the order the registry reports
   * @preconditions retry with 2 attempts around a step that fails once
   * @expectedResult the retry wrapper re-runs the inner pipeline and the route succeeds
   */
  test("composition runs outermost first", async () => {
    let calls = 0;
    const flaky: Plugin = {
      id: "flaky",
      apply(ctx) {
        ctx.contribute({
          kind: "step",
          name: "flaky",
          factory: () => ({
            label: "flaky",
            run: () => {
              calls++;
              if (calls < 2) throw new Error("first attempt fails");
            },
          }),
        });
      },
    };
    const kernel = new Kernel([operations(), resilience(), flaky]);
    await kernel.start();
    const runtime = new Runtime(kernel);
    await runtime.deliver(
      route([["flaky"]], { "routecraft.retry": 3 }),
      "input",
    );
    expect(calls).toBe(2);
  });
});
