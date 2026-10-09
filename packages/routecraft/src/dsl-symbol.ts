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
 * The method a step implements to expose the sub-pipelines it carries
 * (choice branches, multicast paths, dispatch targets, a plugin's own
 * branch) to the walks of a route's step tree: which plugins the route
 * uses, which positions it needs, the continuation digest, and where a
 * `.defer()` may land. A step that runs steps of its own without
 * answering it hides them from every one of those, so a route-scope
 * `.cache()` beside an `.authenticate()` inside it, or an uninstalled
 * plugin's step inside it, goes unrefused, and a park inside it is
 * `RC5051`. A step-scope wrapper forwards it to the step it wraps.
 *
 * A registered symbol, so a step built against the package's other build
 * (ESM beside CJS) answers the same walk.
 *
 * @example
 * ```ts
 * const branch: Step<Adapter> & NestingStep = {
 *   operation: OperationType.PROCESS,
 *   adapter: { adapterId: "acme.branch" },
 *   async execute(exchange) {
 *     return { kind: "branch", exchange, steps };
 *   },
 *   [NESTED_STEPS]: () => [{ steps, rejoins: true }],
 * };
 * ```
 */
export const NESTED_STEPS: unique symbol = Symbol.for(
  "routecraft.step.nestedSteps",
);

/**
 * The mark a step carries when it establishes the exchange's principal, as
 * `.authenticate()` does. The builder refuses a route-scope `.cache()` on a
 * route that reaches such a step (`RC5003`): a cache hit would answer
 * before the step ran, with a key that never saw the identity. A step of
 * yours that mints a principal carries the mark for the same reason.
 *
 * A registered symbol, so the shipped step from the package's other build
 * (ESM beside CJS) is still seen by the guard.
 */
export const AUTHENTICATES: unique symbol = Symbol.for(
  "routecraft.step.authenticates",
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
