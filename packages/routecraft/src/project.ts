// Self-reference via the published specifier so ecosystem augmentations of
// `CraftConfig` reach this module, as in config-applier.ts.
import type { CraftConfig } from "@routecraft/routecraft";
import { BRAND, isBranded, setBrand } from "./brand.ts";
import { RouteBuilder, type PreFromBuilder } from "./builder.ts";
import type { Plugin } from "./kernel/plugin.ts";
import { configuredPlugins } from "./config-applier.ts";
import { applicationPlugins } from "./kernel/defaults.ts";
import { installedPlugins } from "./kernel/host.ts";
import {
  catalogueOf,
  type ConfigKeyPlugins,
  type DefaultPlugins,
} from "./kernel/steps.ts";
import type { PathState } from "./step-builder-base.ts";

/**
 * A project: its configuration, and a `craft()` typed by exactly the plugins
 * it installs.
 *
 * @template Installed - The plugin types the project's routes see
 */
export interface Project<Installed> {
  /**
   * Start a route. Its builder has the step methods of the installed
   * plugins, and its callables see their facets; a step or facet of a
   * plugin the project does not install is a compile error.
   */
  craft(): PreFromBuilder<PathState<unknown, Installed>>;
  /** The configuration to start the application with. */
  readonly config: CraftConfig;
  /** The plugins the project lists, as given. */
  readonly plugins: readonly Plugin[];
}

/**
 * Where a route builder carries the project whose `craft()` started it.
 * A registered symbol, so a builder from another copy of the package still
 * names its project.
 */
const ROUTE_PROJECT = Symbol.for("routecraft.route-project");

/**
 * The project a route was built with, for a tool that runs the route
 * outside its project's own entry point.
 *
 * @param route - A route builder, or anything else
 * @returns The project whose `craft()` started the builder; `undefined`
 *   for a route of the root `craft()`, a built definition, or a non-route
 */
export function projectOf(route: unknown): Project<unknown> | undefined {
  if (typeof route !== "object" || route === null) return undefined;
  const project = (route as Record<symbol, unknown>)[ROUTE_PROJECT];
  return isBranded(project, BRAND.Project)
    ? (project as Project<unknown>)
    : undefined;
}

/**
 * The id of every plugin a configuration installs, defaults and brought
 * plugins included, in install order. What two projects are compared by
 * when a tool asks whether one extends the other.
 *
 * @param config - A project's configuration
 * @returns The ids; a repeatable plugin's id appears once per install
 * @throws RC1117 when a listed plugin is not a descriptor
 */
export function installedPluginIds(config: CraftConfig): string[] {
  return installedPlugins(applicationPlugins(configuredPlugins(config))).map(
    (plugin) => plugin.id,
  );
}

/** What a project definition is: a configuration, plugins included. */
type ProjectDefinition = CraftConfig & { readonly plugins?: readonly Plugin[] };

/** Every key any member of a union has. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** The keys of a shape whose value is a function the shape cannot go without. */
type RequiredMethods<S> = S extends unknown
  ? {
      [K in keyof S]-?: undefined extends S[K]
        ? never
        : S[K] extends (...args: never[]) => unknown
          ? K
          : never;
    }[keyof S]
  : never;

/**
 * Whether a config block is written as a literal of known keys. A block
 * with an index signature takes any key, and one with a required method is
 * an object with behaviour (a logger, a store) whose instances carry more
 * than the interface names; neither is held to its declared keys.
 */
type IsClosedBlock<S> =
  string extends KeysOfUnion<S>
    ? false
    : [RequiredMethods<S>] extends [never]
      ? true
      : false;

/**
 * `never` at every key a definition writes inside a config block that the
 * block does not declare. Intersected into the parameter, it restores the
 * excess-key check one level down, where a generic parameter would lose it:
 * `shutdown: { timeoutMs }` is an error on `timeoutMs`.
 */
type UnknownBlockKeys<D> = {
  [K in keyof D & keyof ProjectDefinition]?: D[K] extends
    readonly unknown[] | ((...args: never[]) => unknown)
    ? unknown
    : D[K] extends object
      ? IsClosedBlock<NonNullable<ProjectDefinition[K]>> extends true
        ? Record<
            Exclude<keyof D[K], KeysOfUnion<NonNullable<ProjectDefinition[K]>>>,
            never
          >
        : unknown
      : unknown;
};

/** The plugin types the config keys a definition sets install. */
type ConfigKeyPluginsOf<D> = {
  [K in keyof ConfigKeyPlugins]: K extends keyof D
    ? undefined extends D[K]
      ? never
      : ConfigKeyPlugins[K]
    : never;
}[keyof ConfigKeyPlugins];

/** The plugin types a definition lists in `plugins`, as listed. */
type ListedPluginsOf<D> = D extends { readonly plugins: readonly (infer P)[] }
  ? P
  : never;

/**
 * The plugin types a union of plugin types brings through `installs`,
 * transitively, the plugins themselves excluded. A brought single plugin
 * whose id may be in `Held` (any member of a union id) is left out together
 * with everything it would bring, the way the application skips that whole
 * subtree when it holds the id itself; a repeatable one is a contribution instance and is kept whatever
 * ids the application holds, as the application installs it.
 */
type BroughtBy<P, Held extends string> = P extends {
  readonly installs: readonly (infer I)[];
}
  ? I extends { readonly id: infer Id extends string }
    ? I extends { readonly repeatable: true }
      ? I | BroughtBy<I, Held>
      : [Extract<Id, Held>] extends [never]
        ? I | BroughtBy<I, Held>
        : never
    : never
  : never;

/**
 * The literal ids of a union of plugin types. A plugin typed with a plain
 * `string` id contributes none, the way an unknown id displaces nothing at
 * runtime: it neither displaces a default nor keeps a brought plugin out.
 */
type LiteralIdOf<P> = P extends { readonly id: infer I extends string }
  ? string extends I
    ? never
    : I
  : never;

/** The plugin types a definition lists and its config keys install. */
type ConfiguredPluginsOf<D> = ListedPluginsOf<D> | ConfigKeyPluginsOf<D>;

/**
 * The default plugin types the definition does not displace: a listed or
 * config-key plugin with a default's id is installed in its place.
 */
type DefaultPluginsFor<D> = Exclude<
  DefaultPlugins,
  { readonly id: LiteralIdOf<ConfiguredPluginsOf<D>> }
>;

/**
 * The plugin types the application itself holds before anything is brought:
 * listed, from config keys, and the defaults those do not displace.
 */
type HeldPluginsOf<D> = ConfiguredPluginsOf<D> | DefaultPluginsFor<D>;

/**
 * Every plugin type a definition installs: what its routes are typed by.
 * The plugins the application holds, then what those bring through
 * `installs`, without any brought plugin whose id the application already
 * holds or anything that plugin would bring, since the application's choice
 * wins over a brought one at runtime. Two brought plugins with one id stay a
 * union here, where the application installs the first it meets.
 */
type InstalledPluginsOf<D> =
  HeldPluginsOf<D> | BroughtBy<HeldPluginsOf<D>, LiteralIdOf<HeldPluginsOf<D>>>;

/**
 * Declare a project: its plugins and configuration, and the `craft()` its
 * routes are built with. `craft.config.ts` default-exports it.
 *
 * The routes are typed by what the application will install: the listed
 * plugins, the plugin each set config key brings that declares itself in
 * `ConfigKeyPlugins`, the defaults none of those displace by id, and what
 * all of them bring through `installs` unless the application already holds
 * that id.
 *
 * @param definition - The configuration, with the plugins the project
 *   installs in `plugins`. A key `CraftConfig` does not have is a compile
 *   error, at the top level and inside each config block.
 * @returns The project
 *
 * @example
 * ```ts
 * // craft.config.ts
 * export default defineProject({ plugins: [dedupe], deferral: { store: "memory" } });
 *
 * // routes/orders.ts
 * import project from "../craft.config.ts";
 * export default project
 *   .craft()
 *   .id("orders")
 *   .from(source)
 *   .dedupe({ key: (order) => order.id })
 *   .to(sink);
 * ```
 */
export function defineProject<const D extends ProjectDefinition>(
  // The mapped `never` restores the excess-key check a generic parameter
  // would otherwise lose: a misspelled key is still an error.
  definition: D &
    Record<Exclude<keyof D, keyof ProjectDefinition>, never> &
    NoInfer<UnknownBlockKeys<D>>,
): Project<InstalledPluginsOf<D>> {
  // The parameter's `never` intersections are for the caller's literal only.
  const given: ProjectDefinition = definition as D;
  const configured = configuredPlugins(given);
  const catalogue = catalogueOf(
    installedPlugins(applicationPlugins(configured)),
  );
  const plugins: readonly Plugin[] = given.plugins ?? [];
  const project: Project<InstalledPluginsOf<D>> = {
    craft: () =>
      Object.defineProperty(new RouteBuilder(catalogue), ROUTE_PROJECT, {
        value: project,
      }) as unknown as PreFromBuilder<
        PathState<unknown, InstalledPluginsOf<D>>
      >,
    config: { ...given, plugins: [...plugins] },
    plugins,
  };
  setBrand(project, BRAND.Project);
  return project;
}
