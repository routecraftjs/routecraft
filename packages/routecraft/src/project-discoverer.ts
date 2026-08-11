// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations.
import type { CraftConfig } from "@routecraft/routecraft";
import { rcError } from "./error.ts";

/**
 * Everything a discoverer is given about the folder it matched and the
 * project around it.
 *
 * Passed as one object rather than positional arguments so the contract
 * can grow (a logger, a dry-run flag) without breaking every ecosystem
 * package that implements one, and so a discoverer never has to derive
 * a path the runner already knows. Deriving `contentRoot` from
 * `directory` looks harmless but bakes in an invariant the runner does
 * not promise.
 */
export interface ProjectDiscoveryContext {
  /** Absolute path of the discovered folder. */
  readonly directory: string;
  /**
   * Absolute path of the content root the folder was found under: the
   * project root, or its `src` when the project uses that layout. A
   * sibling convention folder lives here.
   */
  readonly contentRoot: string;
  /** Absolute path of the project root, where `craft.config.ts` lives. */
  readonly projectRoot: string;
  /**
   * Configuration accumulated so far: the project's own
   * `craft.config.ts` plus every fragment from a discoverer that ran
   * earlier. Never mutated.
   */
  readonly config: Readonly<CraftConfig>;
}

/**
 * Turn a convention folder into a `CraftConfig` fragment.
 *
 * A project runner (`craft start`) walks the filesystem and knows which
 * folders exist; it does not know what the contents mean. A discoverer
 * supplies that meaning for one folder name, which is how `agents/` and
 * `skills/` are understood by `@routecraft/ai` without the CLI ever
 * depending on it.
 *
 * Two rules follow from being handed the accumulated config:
 *
 * - **Precedence is the discoverer's job.** Code wins and convention
 *   fills the gaps, so a discoverer inspects `ctx.config` and declines
 *   to produce anything the project already declared.
 * - **Return the contribution, not the base.** The merge preserves what
 *   is already there, so a fragment should carry only what the
 *   discoverer adds. Copying existing values back into the fragment is
 *   redundant and, for an array-valued field, duplicates entries.
 *
 * The return type is `Partial<CraftConfig>`, which is shallow: it
 * cannot express "a partial value nested inside a record". A fragment
 * that patches one entry of `agent.agents` is still a patch, and may
 * need a cast at the boundary. That is a limitation of the type, not
 * permission to return complete values you did not compute.
 */
export type ProjectDiscoverer = (
  ctx: ProjectDiscoveryContext,
) => Promise<Partial<CraftConfig>>;

/**
 * Registration options for {@link registerProjectDiscoverer}.
 */
export interface ProjectDiscovererOptions {
  /**
   * Folder names whose fragments must already be in `ctx.config` when
   * this discoverer runs. Declaring the dependency beats picking a
   * number: it says which discoverer you need rather than where you
   * hope to sit, and a third party can target a folder name without
   * importing a constant it cannot see.
   *
   * Two edge semantics, both deliberate:
   *
   * - A name nobody registered is a **satisfied** constraint, not an
   *   error. A discoverer that composes another's output when present
   *   must still run when that package is absent.
   * - A cycle is an **error**, raised by {@link getProjectDiscoverers},
   *   because no run order can satisfy it and silently picking one
   *   would make the outcome depend on import order.
   */
  after?: readonly string[];
}

/**
 * A discoverer as held by the registry.
 */
export interface RegisteredProjectDiscoverer {
  /** Folder name, relative to the project's content root. */
  readonly folder: string;
  /** Folder names that must run before this one. */
  readonly after: readonly string[];
  /** The discoverer itself. */
  readonly discover: ProjectDiscoverer;
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
 * import, the same way `registerConfigApplier` promotes a config key.
 * Registering the same folder twice replaces the previous
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
 * @param options - Declared dependencies on other folders
 *
 * @example
 * ```typescript
 * registerProjectDiscoverer(
 *   "agents",
 *   async (ctx) => ({ agent: { agents: await load(ctx) } }),
 *   { after: ["skills"] },
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
    after: options.after ?? [],
    discover: discoverer,
  });
}

/**
 * Get the registered discoverers in run order.
 *
 * Sorted so every declared `after` dependency runs first, with
 * registration order preserved between independent entries so the
 * result is stable. A dependency on a folder nobody registered is
 * satisfied by definition.
 *
 * @throws RC5003 when the declared dependencies form a cycle.
 */
export function getProjectDiscoverers(): readonly RegisteredProjectDiscoverer[] {
  const registered = getRegistry();
  const out: RegisteredProjectDiscoverer[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (entry: RegisteredProjectDiscoverer, trail: string[]): void => {
    if (done.has(entry.folder)) return;
    if (visiting.has(entry.folder)) {
      throw rcError("RC5003", undefined, {
        message: `Project discoverers form a dependency cycle: ${[...trail, entry.folder].join(" -> ")}. One of the "after" declarations has to go; no run order can satisfy a cycle.`,
      });
    }
    visiting.add(entry.folder);
    for (const dependency of entry.after) {
      const next = registered.get(dependency);
      // A dependency nobody registered is satisfied: the package that
      // would have claimed the folder simply is not installed.
      if (next) visit(next, [...trail, entry.folder]);
    }
    visiting.delete(entry.folder);
    done.add(entry.folder);
    out.push(entry);
  };

  for (const entry of registered.values()) visit(entry, []);
  return out;
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

/**
 * Write a key without going through a setter. `out[key] = value` would
 * hit `Object.prototype.__proto__` for a key of that name, silently
 * dropping the entry and changing the object's prototype; the spread
 * that seeded `out` defines it as a real own property, so the two
 * halves of this function have to agree.
 */
function define(
  target: Record<string | symbol, unknown>,
  key: string | symbol,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function mergeRecords(
  base: Record<string, unknown>,
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  // Spread and `Reflect.ownKeys` rather than `Object.entries` so own
  // symbol keys survive on both sides; see isMergeableRecord.
  const out: Record<string, unknown> = { ...base };
  const target = out as Record<string | symbol, unknown>;
  for (const key of Reflect.ownKeys(fragment) as Array<string | symbol>) {
    const value = (fragment as Record<string | symbol, unknown>)[key];
    if (value === undefined) continue;
    const current = target[key];
    if (isMergeableRecord(current) && isMergeableRecord(value)) {
      define(target, key, mergeRecords(current, value));
    } else if (Array.isArray(current) && Array.isArray(value)) {
      define(target, key, [...current, ...value]);
    } else {
      define(target, key, value);
    }
  }
  return out;
}
