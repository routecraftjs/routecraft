import type { CraftPlugin } from "./context.ts";
// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations.
import type { CraftConfig } from "@routecraft/routecraft";

/**
 * Build a {@link CraftPlugin} from the value found at a given key on
 * {@link CraftConfig}. Receives the non-undefined value of `config[K]` and
 * returns a plugin whose `apply` and (optional) `teardown` participate in the
 * standard plugin lifecycle.
 *
 * @template K - Key on `CraftConfig` this applier handles
 *
 * @experimental
 */
export type ConfigApplier<K extends keyof CraftConfig> = (
  options: NonNullable<CraftConfig[K]>,
) => CraftPlugin;

/**
 * Internal applier signature used by the registry. Public callers go through
 * {@link registerConfigApplier} which preserves the typed `K`.
 */
type AnyConfigApplier = (options: unknown) => CraftPlugin;

/**
 * Cross-instance registry. `Symbol.for` so multiple copies of the package in
 * a workspace share a single registry; without this, an applier registered
 * by one package copy would be invisible to a `CraftContext` constructed
 * from another copy.
 */
const REGISTRY_KEY: unique symbol = Symbol.for(
  "routecraft.config-applier-registry",
);

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, AnyConfigApplier>;
};

function getRegistry(): Map<string, AnyConfigApplier> {
  const g = globalThis as GlobalWithRegistry;
  let registry = g[REGISTRY_KEY];
  if (!registry) {
    registry = new Map<string, AnyConfigApplier>();
    g[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Register a function that converts a {@link CraftConfig} key into a plugin.
 *
 * Ecosystem packages call this once at module load time (typically from a
 * side-effect import) so that setting `config[key]` becomes equivalent to
 * pushing the corresponding plugin onto `config.plugins`. Resulting plugins
 * participate in the standard lifecycle: `apply()` runs during
 * `initPlugins()`, `teardown()` runs during `context.stop()`.
 *
 * Re-registering a key replaces the previous registration: last writer wins.
 * The registry is shared across copies of the package via `Symbol.for`, but
 * an applier registered by one copy of an ecosystem package is a different
 * function reference from the same applier registered by another copy. If
 * two copies of `@routecraft/ai` end up in the same workspace, the last one
 * to load is the one whose applier (and therefore whose `llmPlugin`
 * instance) runs. Structure your workspace to avoid duplicate copies of the
 * same ecosystem package; this registry does not transparently de-duplicate.
 *
 * @template K - Key on `CraftConfig` this applier handles
 * @param key - The `CraftConfig` key
 * @param applier - Factory that builds a plugin from the value at `config[key]`
 *
 * @experimental
 *
 * @example
 * ```typescript
 * declare module "@routecraft/routecraft" {
 *   interface CraftConfig {
 *     myKey?: MyOptions;
 *   }
 * }
 *
 * registerConfigApplier("myKey", (options) => myPlugin(options));
 * ```
 */
export function registerConfigApplier<K extends keyof CraftConfig>(
  key: K,
  applier: ConfigApplier<K>,
): void {
  // Cast: at runtime we always invoke the applier with the value at config[key],
  // which TS narrows to the registered type at the registration site. Storing
  // as an unknown-keyed function lets the registry hold heterogeneous appliers.
  getRegistry().set(key as string, applier as AnyConfigApplier);
}

/**
 * Get the registered config appliers in registration order.
 *
 * Consumed by `CraftContext` and `ContextBuilder` to convert first-class
 * config keys into plugins at construction time. Iteration order matches
 * registration order, which the constructor relies on to position ecosystem
 * appliers between core inline conversions and `config.plugins`.
 *
 * @internal
 */
export function getConfigAppliers(): ReadonlyMap<string, AnyConfigApplier> {
  return getRegistry();
}
