// Self-reference via the published specifier so ecosystem augmentations of
// `CraftConfig` reach this module, as in define-config.ts.
import type { CraftConfig } from "@routecraft/routecraft";
import { BRAND, setBrand } from "./brand.ts";
import { RouteBuilder, type PreFromBuilder } from "./builder.ts";
import type { Plugin } from "./kernel/plugin.ts";
import { catalogueOf } from "./kernel/steps.ts";
import { authSteps } from "./plugins/auth/index.ts";
import type { DefaultPlugins } from "./plugins/catalogue.ts";
import { deferralSteps } from "./deferral/steps.ts";
import type { DeferralPlugin } from "./deferral/config.ts";
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
 * Declare a project: its plugins and configuration, and the `craft()` its
 * routes are built with. `craft.config.ts` default-exports it.
 *
 * @param definition - The configuration, with the plugins the project
 *   installs in `plugins`
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
// Overloads rather than a generic config, so a misspelled key is still an
// error: excess properties are checked only against a concrete type.
export function defineProject<const P extends readonly Plugin[] = []>(
  definition: CraftConfig & {
    readonly plugins?: P;
    readonly deferral: NonNullable<CraftConfig["deferral"]>;
  },
): Project<P[number] | DefaultPlugins | DeferralPlugin>;
export function defineProject<const P extends readonly Plugin[] = []>(
  definition: CraftConfig & { readonly plugins?: P },
): Project<P[number] | DefaultPlugins>;
export function defineProject(
  definition: CraftConfig & { readonly plugins?: readonly Plugin[] },
): Project<unknown> {
  const plugins: readonly Plugin[] = definition.plugins ?? [];
  const listed = new Set(plugins.map((plugin) => plugin.id));
  const catalogue = catalogueOf([
    ...(listed.has("routecraft.auth")
      ? []
      : [{ id: "routecraft.auth", steps: authSteps }]),
    ...(definition.deferral !== undefined && !listed.has("routecraft.deferral")
      ? [{ id: "routecraft.deferral", steps: deferralSteps }]
      : []),
    ...plugins,
  ]);
  const project: Project<unknown> = {
    craft: () =>
      new RouteBuilder(catalogue) as unknown as PreFromBuilder<
        PathState<unknown, unknown>
      >,
    config: { ...definition, plugins: [...plugins] },
    plugins,
  };
  setBrand(project, BRAND.Project);
  return project;
}
