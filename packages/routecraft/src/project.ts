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
 * A plugin type with every plugin its `installs` bring, transitively, the
 * way the application expands them.
 */
type WithInstalls<P> =
  | P
  | (P extends { readonly installs: readonly (infer I)[] }
      ? WithInstalls<I>
      : never);

/** The ids of a union of plugin types. */
type IdOf<P> = P extends { readonly id: infer I extends string } ? I : never;

/**
 * The default plugin types the definition does not displace: a listed or
 * config-key plugin with a default's id is installed in its place. Only a
 * literal id can displace; a plugin typed with a plain `string` id displaces
 * nothing, the way an unknown id displaces nothing at runtime.
 */
type DefaultPluginsFor<D> =
  string extends IdOf<ListedPluginsOf<D> | ConfigKeyPluginsOf<D>>
    ? DefaultPlugins
    : Exclude<
        DefaultPlugins,
        { readonly id: IdOf<ListedPluginsOf<D> | ConfigKeyPluginsOf<D>> }
      >;

/** Every plugin type a definition installs: what its routes are typed by. */
type InstalledPluginsOf<D> =
  | WithInstalls<ListedPluginsOf<D> | ConfigKeyPluginsOf<D>>
  | DefaultPluginsFor<D>;

/**
 * Declare a project: its plugins and configuration, and the `craft()` its
 * routes are built with. `craft.config.ts` default-exports it.
 *
 * The routes are typed by what the application will install: the listed
 * plugins and what their `installs` bring, the plugin each set config key
 * brings that declares itself in `ConfigKeyPlugins`, and the defaults none
 * of those displace by id.
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
