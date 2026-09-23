import {
  infrastructure,
  point,
  allRuns,
  type Exchange,
  type StepContext,
} from "../../src/v2/index.ts";

const OWNER: unique symbol = Symbol("typed-deferred-point");
declare module "../../src/v2/contracts.ts" {
  interface HandlerPoints {
    typedDeferredPoint: {
      readonly owner: typeof OWNER;
      readonly refuse: false;
      readonly defer: true;
    };
  }
}

export const plugin = infrastructure({
  id: "review.typedpoint",
  points: [point("typedDeferredPoint", OWNER, false, true)],
  bind(context) {
    context.contribute({
      kind: "handler",
      id: "wait",
      point: "typedDeferredPoint",
      survival: allRuns,
      mayDefer: true,
      handle: () => ({
        kind: "defer",
        request: { name: "wait", reason: "typed example" },
      }),
    });
  },
});

// No cast: this public caller cannot recover the defer request the type allowed.
export function invoke(
  context: StepContext,
  exchange: Exchange,
): Promise<Exchange | null> {
  return context.invoke("typedDeferredPoint", exchange);
}
