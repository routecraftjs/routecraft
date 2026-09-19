import { describe, expect, test } from "bun:test";
import { Kernel } from "../src/kernel/index.ts";
import { CycleError, MissingNodeError } from "../src/kernel/graph.ts";
import { stores } from "../src/plugins/stores.ts";
import { deferral } from "../src/plugins/deferral.ts";
import type { Plugin } from "../src/contracts/index.ts";

describe("kernel: dependency graph", () => {
  /**
   * @case A plugin declaring a dependency is installed after it
   * @preconditions deferral dependsOn stores; the list is given in the wrong order
   * @expectedResult stores sorts before deferral
   */
  test("sorts by dependsOn regardless of declaration order", () => {
    const kernel = new Kernel([deferral(), stores()]);
    expect(kernel.order).toEqual(["routecraft.stores", "routecraft.deferral"]);
  });

  /**
   * @case A declared dependency is not installed
   * @preconditions deferral is given without stores
   * @expectedResult construction throws, naming both the needed and the needing plugin
   */
  test("refuses a missing dependency at construction, naming both sides", () => {
    expect(() => new Kernel([deferral()])).toThrow(MissingNodeError);
    try {
      new Kernel([deferral()]);
    } catch (error) {
      expect((error as Error).message).toContain("routecraft.deferral");
      expect((error as Error).message).toContain("routecraft.stores");
    }
  });

  /**
   * @case Two plugins depend on each other
   * @preconditions a declares dependsOn b and b declares dependsOn a
   * @expectedResult construction throws a CycleError carrying the cycle path
   */
  test("refuses a dependency cycle and names it", () => {
    const a: Plugin = { id: "a", dependsOn: ["b"] };
    const b: Plugin = { id: "b", dependsOn: ["a"] };
    expect(() => new Kernel([a, b])).toThrow(CycleError);
  });

  /**
   * @case Teardown must not run a plugin that never applied
   * @preconditions the second plugin throws during apply
   * @expectedResult the third plugin's stop never runs
   */
  test("tears down only plugins that applied", async () => {
    const stopped: string[] = [];
    const ok: Plugin = { id: "ok", stop: () => void stopped.push("ok") };
    const boom: Plugin = {
      id: "boom",
      dependsOn: ["ok"],
      apply: () => {
        throw new Error("boom");
      },
      stop: () => void stopped.push("boom"),
    };
    const never: Plugin = {
      id: "never",
      dependsOn: ["boom"],
      stop: () => void stopped.push("never"),
    };
    const kernel = new Kernel([ok, boom, never]);
    await expect(kernel.start()).rejects.toThrow("boom");
    await kernel.stop();
    expect(stopped).toEqual(["ok"]);
  });

  /**
   * @case Health is aggregated per plugin
   * @preconditions a kernel with stores started
   * @expectedResult health reports an entry keyed by plugin id
   */
  test("aggregates health by plugin id", async () => {
    const kernel = new Kernel([stores()]);
    await kernel.start();
    const health = await kernel.health();
    expect(health["routecraft.stores"]?.up).toBe(true);
  });
});
