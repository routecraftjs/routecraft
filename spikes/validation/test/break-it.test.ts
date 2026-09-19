import { describe, expect, test } from "bun:test";
import { Kernel } from "../../plugin-architecture/src/kernel/index.ts";
import {
  Runtime,
  type RouteSpec,
} from "../../plugin-architecture/src/runtime/index.ts";
import { operations } from "../../plugin-architecture/src/plugins/operations.ts";
import { stores } from "../../plugin-architecture/src/plugins/stores.ts";
import type { Plugin } from "../../plugin-architecture/src/contracts/index.ts";

const route = (steps: RouteSpec["steps"]): RouteSpec => ({
  id: "demo",
  source: { label: "none", subscribe: () => Promise.resolve(() => {}) },
  steps,
});

/**
 * The plugin the spike's contracts cannot express: real deferral.
 *
 * The spike's `deferral` plugin writes a row and lets the pipeline run on.
 * Actual deferral stops the exchange at step N, persists a continuation, and
 * resumes later at step N+1 with the work before it not repeated. That is
 * the whole reason deferral sits at 202 references across 14 core files.
 */
describe("breaking the design: a plugin that halts and resumes", () => {
  /**
   * @case A step tries to stop the pipeline without failing the exchange
   * @preconditions a contributed step that wants to halt after running
   * @expectedResult it cannot: `Step.run` returns void, so the only signal a
   *   step can send the executor is a throw, which is a failure, not a halt
   */
  test("a contributed step cannot halt the pipeline except by throwing", async () => {
    const after: string[] = [];
    const halting: Plugin = {
      id: "acme.halt",
      apply(ctx) {
        ctx.contribute({
          kind: "step",
          name: "halt",
          // There is no return value, no exchange flag core reads, and no
          // handler point between steps. Nothing here can stop step 2.
          factory: () => ({ label: "halt", run: () => {} }),
        });
        ctx.contribute({
          kind: "step",
          name: "mark",
          factory: () => ({ label: "mark", run: () => void after.push("ran") }),
        });
      },
    };
    const kernel = new Kernel([operations(), halting]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["halt"], ["mark"]]), "x");
    // The step after the halt ran anyway. Halt is not expressible.
    expect(after).toEqual(["ran"]);
  });

  /**
   * @case A wrapper tries to halt from inside the pipeline
   * @preconditions a wrapper that decides mid-chain not to continue
   * @expectedResult a wrapper can only decline to call `next`, which skips
   *   the WHOLE pipeline; it has no access to the step list, so it cannot
   *   stop at step 2 of 3
   */
  test("a wrapper can skip everything or nothing, never a suffix", async () => {
    const ran: string[] = [];
    const gate: Plugin = {
      id: "acme.gate",
      apply(ctx) {
        ctx.contribute({
          kind: "wrapper",
          id: "acme.gate",
          // `next` is the composed pipeline. The only choices are call it
          // or do not. `RouteView` exposes labels, never the steps.
          wrap: (next, view) => async (ex) => {
            expect(view.stepLabels).toEqual(["a", "b", "c"]);
            await next(ex);
          },
        });
        for (const name of ["a", "b", "c"]) {
          ctx.contribute({
            kind: "step",
            name,
            factory: () => ({ label: name, run: () => void ran.push(name) }),
          });
        }
      },
    };
    const kernel = new Kernel([gate]);
    await kernel.start();
    await new Runtime(kernel).deliver(route([["a"], ["b"], ["c"]]), "x");
    expect(ran).toEqual(["a", "b", "c"]);
  });

  /**
   * @case Resuming a halted exchange at the step after the halt
   * @preconditions an exchange halted at step 2 of 3, resumed later
   * @expectedResult impossible: `Runtime.assemble` builds a closure that
   *   loops the whole step list from index 0, and no contribution kind can
   *   supply an entry offset, so resuming re-runs the steps already done
   */
  test("resuming re-runs the steps already done, because there is no entry offset", async () => {
    const ran: string[] = [];
    const plugin: Plugin = {
      id: "acme.steps",
      apply(ctx) {
        for (const name of ["a", "b", "c"]) {
          ctx.contribute({
            kind: "step",
            name,
            factory: () => ({ label: name, run: () => void ran.push(name) }),
          });
        }
      },
    };
    const kernel = new Kernel([stores(), plugin]);
    await kernel.start();
    const runtime = new Runtime(kernel);
    const spec = route([["a"], ["b"], ["c"]]);
    await runtime.deliver(spec, "x");
    ran.length = 0;
    // A resume is just another delivery. There is no API that says
    // "continue this exchange at step 2".
    await runtime.deliver(spec, "x");
    expect(ran).toEqual(["a", "b", "c"]);
  });

  /**
   * @case The design's fifth intervention point
   * @preconditions the design names five points including "source"
   * @expectedResult the spike implements four; a source cannot be contributed
   */
  test("the source intervention point the design names does not exist", async () => {
    const kernel = new Kernel([operations()]);
    await kernel.start();
    // `InterventionPoint` in the spike is "wrapper" | "step" | "handler" |
    // "exchange". There is no "source", and `RouteSpec.source` is never
    // subscribed by the runtime at all.
    const sourceWasSubscribed: string[] = [];
    await new Runtime(kernel).deliver(
      {
        id: "r",
        source: {
          label: "never-called",
          subscribe: () => {
            sourceWasSubscribed.push("yes");
            return Promise.resolve(() => {});
          },
        },
        steps: [["tap", () => {}]],
      },
      "x",
    );
    expect(sourceWasSubscribed).toEqual([]);
  });
});
