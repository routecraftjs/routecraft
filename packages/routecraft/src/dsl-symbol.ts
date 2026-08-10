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
 * Symbol used by sub-pipeline builders (the shared PathBuilder for choice and
 * multicast paths) to hand their compiled step array back to their parent Step
 * without exposing a public `.steps()` API. Keeps the "no headless builder"
 * constraint on RouteBuilder intact.
 *
 * @internal
 */
export const COLLECT_STEPS: unique symbol = Symbol.for(
  "routecraft.builder.collectSteps",
);

/**
 * Symbol a step implements to expose the sub-pipelines it carries (choice
 * branches, multicast paths, dispatch targets) to framework-level walks of
 * a route's step tree, without widening the public `Step` contract or
 * making those step arrays writable from outside.
 *
 * The one walk today is the suspend-site resolver, which has to know both
 * that a sub-pipeline exists and whether it rejoins the main flow.
 *
 * @internal
 */
export const NESTED_STEPS: unique symbol = Symbol.for(
  "routecraft.step.nestedSteps",
);
