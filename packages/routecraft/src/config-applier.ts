import type { Plugin } from "./kernel/plugin.ts";
// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations.
import type { CraftConfig } from "@routecraft/routecraft";

/**
 * Build a {@link Plugin} from the value found at a given key on
 * {@link CraftConfig}. Receives the non-undefined value of `config[K]` and
 * returns the plugin's descriptor. Pure: it may be called more than once for
 * one configuration (by `defineProject` and by the application), so any work
 * belongs in the plugin's `bind`.
 *
 * @template K - Key on `CraftConfig` this applier handles
 */
export type ConfigApplier<K extends keyof CraftConfig> = (
  options: NonNullable<CraftConfig[K]>,
) => Plugin;

/**
 * Internal applier signature used by the registry. Public callers go through
 * {@link registerConfigApplier} which preserves the typed `K`.
 */
type AnyConfigApplier = (options: unknown) => Plugin;

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
 * The framework invokes the applier whenever `config[key] !== undefined`.
 * Falsy values (`false`, `0`, `""`, `null`) are still passed through; only
 * `undefined` means "not set". This lets primitive-valued keys behave
 * sensibly without needing a wrapper object.
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
 * @internal
 */
export function getConfigAppliers(): ReadonlyMap<string, AnyConfigApplier> {
  return getRegistry();
}

/**
 * The plugins a configuration installs before the defaults: one per config
 * key that is set, in applier registration order, then `plugins` as listed.
 * The application and `defineProject` both compose from this, so the plugins
 * a project's routes are typed by are the ones its application installs.
 *
 * The guard is strictly `value !== undefined`: appliers are an open
 * registry, and a key whose valid value is `false`, `0` or `""` is still set.
 *
 * @internal
 */
export function configuredPlugins(config: CraftConfig): unknown[] {
  const record = config as unknown as Record<string, unknown>;
  const plugins: unknown[] = [];
  for (const [key, factory] of getRegistry()) {
    const value = record[key];
    if (value !== undefined) plugins.push(factory(value));
  }
  plugins.push(...(config.plugins ?? []));
  return plugins;
}
