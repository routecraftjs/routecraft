/**
 * Symbol used by registerDsl to access the builder's internal addStep method.
 * Defined in a separate module to avoid circular imports between builder.ts
 * and dsl.ts.
 *
 * @internal
 */
export const PUSH_STEP: unique symbol = Symbol.for(
  "routecraft.builder.pushStep",
);

/**
 * Symbol used by sub-pipeline builders (BranchBuilder for choice, PathBuilder
 * for multicast) to hand their compiled step array back to their parent Step
 * without exposing a public `.steps()` API. Keeps the "no headless builder"
 * constraint on RouteBuilder intact.
 *
 * @internal
 */
export const COLLECT_STEPS: unique symbol = Symbol.for(
  "routecraft.builder.collectSteps",
);
