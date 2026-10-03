// Self-reference via the published specifier so ecosystem augmentations of
// `CraftConfig` reach this module, as in define-config.ts.
import type { CraftConfig } from "@routecraft/routecraft";
import { BRAND, setBrand } from "./brand.ts";
import { RouteBuilder, type PreFromBuilder } from "./builder.ts";
import type { Plugin } from "./kernel/plugin.ts";
import { configuredPlugins } from "./config-applier.ts";
import { defaultPluginsFor } from "./kernel/defaults.ts";
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

/** The plugin types a definition lists in `plugins`. */
type ListedPluginsOf<D> = D extends { readonly plugins: readonly (infer P)[] }
  ? P
  : never;

/**
 * Declare a project: its plugins and configuration, and the `craft()` its
 * routes are built with. `craft.config.ts` default-exports it.
 *
 * The routes are typed by what the application will install: the listed
 * plugins, the defaults, and the plugin each set config key brings that
 * declares itself in `ConfigKeyPlugins`.
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
): Project<ListedPluginsOf<D> | DefaultPlugins | ConfigKeyPluginsOf<D>> {
  const configured = configuredPlugins(definition);
  const catalogue = catalogueOf(
    installedPlugins([...defaultPluginsFor(configured), ...configured]),
  );
  const plugins: readonly Plugin[] = definition.plugins ?? [];
  const project: Project<
    ListedPluginsOf<D> | DefaultPlugins | ConfigKeyPluginsOf<D>
  > = {
    craft: () =>
      new RouteBuilder(catalogue) as unknown as PreFromBuilder<
        PathState<
          unknown,
          ListedPluginsOf<D> | DefaultPlugins | ConfigKeyPluginsOf<D>
        >
      >,
    config: { ...definition, plugins: [...plugins] },
    plugins,
  };
  setBrand(project, BRAND.Project);
  return project;
}
