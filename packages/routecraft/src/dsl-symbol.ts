/**
 * Symbol for the builder's internal step append, so a plugin step method
 * and a test can push a step without `pushStep` becoming public API.
 *
 * @internal
 */
export const PUSH_STEP: unique symbol = Symbol.for(
  "routecraft.builder.pushStep",
);

/**
 * Which builder a value is: a type-level brand `Retyped` matches on, so it
 * never has to infer a builder's state to know which builder to return.
 *
 * @internal
 */
export const BUILDER_KIND: unique symbol = Symbol.for(
  "routecraft.builder.kind",
);

/**
 * A builder's state, as a type-level member `BodyOf` reads without
 * inferring through the builder's plugin methods.
 *
 * @internal
 */
export const BUILDER_STATE: unique symbol = Symbol.for(
  "routecraft.builder.state",
);

/**
 * The plugin steps a builder installs as methods, handed to the builders it
 * creates for branches so a branch has the same methods as its route.
 *
 * @internal
 */
export const CATALOGUE: unique symbol = Symbol.for(
  "routecraft.builder.catalogue",
);

/**
 * The id of the plugin whose `steps` entry built a step. A route checks at
 * start that every such plugin is installed.
 *
 * @internal
 */
export const STEP_PLUGIN: unique symbol = Symbol.for("routecraft.step.plugin");

/**
 * The arguments a plugin step's factory was called with, stamped on the
 * step it returned so the continuation hash and the cache fingerprint can
 * tell `.withTax(0.1)` from `.withTax(0.2)`: the factory's closure is not
 * otherwise visible to either.
 *
 * @internal
 */
export const STEP_ARGS: unique symbol = Symbol.for("routecraft.step.args");

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
 * The one walk today is the defer-site resolver, which has to know both
 * that a sub-pipeline exists and whether it rejoins the main flow.
 *
 * @internal
 */
export const NESTED_STEPS: unique symbol = Symbol.for(
  "routecraft.step.nestedSteps",
);

/**
 * Symbol a step implements to expose the step instance that hosts a
 * re-entrant defer site: the `.to()` / `.enrich()` step whose adapter
 * carries the defer-capable brand. Step-scope wrappers forward it to
 * their inner step (like {@link NESTED_STEPS}), so the defer-site walk
 * can store the site on the instance whose `execute` converts the defer
 * signal, however deeply the step is wrapped.
 *
 * @internal
 */
export const DEFER_HOST: unique symbol = Symbol.for(
  "routecraft.step.deferHost",
);
