// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations.
import type { CraftConfig } from "@routecraft/routecraft";

/**
 * Turn a convention folder into a `CraftConfig` fragment.
 *
 * A project runner (`craft start`) walks the filesystem and knows which
 * folders exist; it does not know what the contents mean. A discoverer
 * supplies that meaning for one folder name, which is how `agents/` and
 * `skills/` are understood by `@routecraft/ai` without the CLI ever
 * depending on it.
 *
 * `config` is the configuration accumulated so far: the project's own
 * `craft.config.ts` plus every fragment from a lower-ordered
 * discoverer. Two things follow from that:
 *
 * - **Precedence is the discoverer's job.** Code wins and convention
 *   fills the gaps, so a discoverer inspects `config` and declines to
 *   produce anything the project already declared.
 * - **Discoverers can build on each other.** The `agents` discoverer
 *   reads the house skills the `skills` discoverer contributed, because
 *   it runs at a higher order.
 *
 * @param directory - Absolute path of the discovered folder
 * @param config - Configuration accumulated so far, never mutated
 */
export type ProjectDiscoverer = (
  directory: string,
  config: Readonly<CraftConfig>,
) => Promise<Partial<CraftConfig>>;

/**
 * Registration options for {@link registerProjectDiscoverer}.
 */
export interface ProjectDiscovererOptions {
  /**
   * Run order, ascending, defaulting to `0`. Ties keep registration
   * order. Set it when a discoverer needs another one's fragment to
   * already be in `config`: `@routecraft/ai` orders `skills` ahead of
   * `agents` so an agent bundle can compose the house skills rather
   * than silently replacing them.
   */
  order?: number;
}

/**
 * A discoverer as held by the registry.
 */
export interface RegisteredProjectDiscoverer {
  /** Folder name, relative to the project's content root. */
  folder: string;
  /** Run order, ascending. */
  order: number;
  /** The discoverer itself. */
  discover: ProjectDiscoverer;
}

/**
 * Cross-instance registry. `Symbol.for` so multiple copies of the
 * package in a workspace share a single registry; without this, a
 * discoverer registered by one package copy would be invisible to a
 * runner constructed from another copy.
 */
const REGISTRY_KEY: unique symbol = Symbol.for(
  "routecraft.project-discoverer-registry",
);

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, RegisteredProjectDiscoverer>;
};

function getRegistry(): Map<string, RegisteredProjectDiscoverer> {
  const g = globalThis as GlobalWithRegistry;
  let registry = g[REGISTRY_KEY];
  if (!registry) {
    registry = new Map<string, RegisteredProjectDiscoverer>();
    g[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Register a discoverer for one convention folder.
 *
 * Ecosystem packages call this at module load time from a side-effect
 * import, the same way {@link registerConfigApplier} promotes a config
 * key. Registering the same folder twice replaces the previous
 * registration: last writer wins.
 *
 * Registration happens on **import**, which is worth stating plainly
 * because it is the failure mode users hit: a project whose
 * `craft.config.ts` only carries `import type { ... }` from the
 * package never registers anything, because a type-only import is
 * erased at compile time.
 *
 * @param folder - Folder name relative to the project's content root
 * @param discoverer - Builds a config fragment from that folder
 * @param options - Run order
 *
 * @example
 * ```typescript
 * registerProjectDiscoverer(
 *   "agents",
 *   async (dir, config) => ({ agent: { agents: await load(dir, config) } }),
 *   { order: 20 },
 * );
 * ```
 */
export function registerProjectDiscoverer(
  folder: string,
  discoverer: ProjectDiscoverer,
  options: ProjectDiscovererOptions = {},
): void {
  getRegistry().set(folder, {
    folder,
    order: options.order ?? 0,
    discover: discoverer,
  });
}

/**
 * Get the registered discoverers in run order: ascending `order`, then
 * registration order for ties.
 */
export function getProjectDiscoverers(): readonly RegisteredProjectDiscoverer[] {
  // Registration order is Map insertion order, and Array.prototype.sort
  // is stable, so sorting by `order` alone preserves it within a tier.
  return [...getRegistry().values()].sort((a, b) => a.order - b.order);
}

/**
 * True for objects the merge is allowed to recurse into: object
 * literals and null-prototype records. Class instances, arrays, and
 * functions are values, not shapes to combine.
 *
 * An object carrying own symbol keys is also treated as a value. Those
 * keys are how the framework brands cross-instance types (a
 * `ToolSelection` is an object literal with a `Symbol.for` brand), and
 * a rebuilt copy would be a different thing wearing the same shape.
 */
function isMergeableRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

/**
 * Merge a discoverer's fragment into a configuration and return a new
 * object. Neither input is mutated.
 *
 * Rules, in order:
 *
 * 1. An `undefined` value in the fragment is ignored, so a discoverer
 *    that produces nothing can return `{}` or omit the key.
 * 2. Two plain objects merge recursively. This is what puts a
 *    discovered agent beside a config-declared one instead of
 *    replacing the whole map.
 * 3. Two arrays concatenate, base first, which is how a discovered
 *    plugin joins the ones the project declared.
 * 4. Anything else: the fragment's value replaces the base's.
 *
 * Rule 4 is the reason precedence lives in the discoverer rather than
 * here. The merge cannot tell an intentional override from an
 * accidental one; the discoverer can, because it is handed the config
 * before it decides what to return.
 */
export function mergeProjectConfig(
  base: CraftConfig,
  fragment: Partial<CraftConfig>,
): CraftConfig {
  return mergeRecords(
    base as Record<string, unknown>,
    fragment as Record<string, unknown>,
  ) as CraftConfig;
}

function mergeRecords(
  base: Record<string, unknown>,
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  // Spread and `Reflect.ownKeys` rather than `Object.entries` so own
  // symbol keys survive on both sides; see isMergeableRecord.
  const out: Record<string, unknown> = { ...base };
  for (const key of Reflect.ownKeys(fragment) as Array<string | symbol>) {
    const value = (fragment as Record<string | symbol, unknown>)[key];
    if (value === undefined) continue;
    const current = (out as Record<string | symbol, unknown>)[key];
    if (isMergeableRecord(current) && isMergeableRecord(value)) {
      (out as Record<string | symbol, unknown>)[key] = mergeRecords(
        current,
        value,
      );
    } else if (Array.isArray(current) && Array.isArray(value)) {
      (out as Record<string | symbol, unknown>)[key] = [...current, ...value];
    } else {
      (out as Record<string | symbol, unknown>)[key] = value;
    }
  }
  return out;
}
