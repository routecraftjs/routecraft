// Self-reference via the published specifier so ecosystem augmentations of
// `CraftConfig` reach this module, as in define-config.ts.
import type { CraftConfig } from "@routecraft/routecraft";
import { BRAND, setBrand } from "./brand.ts";
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

/** What a project definition is: a configuration, plugins included. */
type ProjectDefinition = CraftConfig & { readonly plugins?: readonly Plugin[] };

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
 * whose id is in `Held` is left out together with everything it would bring,
 * the way the application skips that whole subtree when it holds the id
 * itself; a repeatable one is a contribution instance and is kept whatever
 * ids the application holds, as the application installs it.
 */
type BroughtBy<P, Held extends string> = P extends {
  readonly installs: readonly (infer I)[];
}
  ? I extends { readonly id: infer Id extends string }
    ? I extends { readonly repeatable: true }
      ? I | BroughtBy<I, Held>
      : Id extends Held
        ? never
        : I | BroughtBy<I, Held>
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
 *   error.
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
  definition: D & Record<Exclude<keyof D, keyof ProjectDefinition>, never>,
): Project<InstalledPluginsOf<D>> {
  const configured = configuredPlugins(definition);
  const catalogue = catalogueOf(
    installedPlugins(applicationPlugins(configured)),
  );
  const plugins: readonly Plugin[] = definition.plugins ?? [];
  const project: Project<InstalledPluginsOf<D>> = {
    craft: () =>
      new RouteBuilder(catalogue) as unknown as PreFromBuilder<
        PathState<unknown, InstalledPluginsOf<D>>
      >,
    config: { ...definition, plugins: [...plugins] },
    plugins,
  };
  setBrand(project, BRAND.Project);
  return project;
}
