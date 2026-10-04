import { installFacet } from "./facets.ts";
import { namespaceOf, type Plugin } from "./plugin.ts";

interface ShippedPlugin {
  readonly factory: () => Plugin;
  readonly descriptor: Plugin;
  readonly installedByDefault: boolean;
}

const shipped = new Map<string, ShippedPlugin>();

/**
 * Register a plugin `@routecraft/routecraft` ships: its steps become methods
 * of the root `craft()`, its facet readable as `ex.<namespace>`, and with
 * `default` it is installed in every application that does not install its
 * own plugin with the same id.
 *
 * How the framework's own positions get their providers without the kernel
 * importing a plugin: each shipped plugin's module registers itself when the
 * package entry loads. A default is a default because it is installed by
 * default, not because the kernel knows its name; replacing what it provides
 * is the ordinary `replaces` declaration.
 *
 * Module-local: a second copy of the package keeps its own registry, so its
 * defaults provide its own ports and never stand in for the first copy's.
 *
 * @param factory - Builds a fresh descriptor; called once here to read the
 *   id, steps and facet, and once per application for a default
 * @param options - `default` installs it in every application
 * @internal
 */
export function registerShippedPlugin(
  factory: () => Plugin,
  options: { readonly default?: boolean } = {},
): void {
  const descriptor = factory();
  shipped.set(descriptor.id, {
    factory,
    descriptor,
    installedByDefault: options.default === true,
  });
  // Installed now rather than when an application installs the plugin, so a
  // root craft() route reading the facet on an application without it gets
  // the kernel's refusal instead of a TypeError on undefined.
  if (descriptor.facet) {
    installFacet(namespaceOf(descriptor));
  }
}

/**
 * The default plugins an application gets, in registration order, minus any
 * whose id the application installs itself.
 *
 * @internal
 */
export function defaultPluginsFor(installed: readonly unknown[]): Plugin[] {
  const ids = new Set(
    installed
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null
          ? (plugin as { id?: unknown }).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string"),
  );
  return [...shipped.values()]
    .filter(
      ({ descriptor, installedByDefault }) =>
        installedByDefault && !ids.has(descriptor.id),
    )
    .map(({ factory }) => factory());
}

/**
 * What an application installs before brought plugins are expanded: the
 * defaults its configuration does not override, then its configured
 * plugins. Defaults go first because they are what the application's
 * plugins build on, and ahead of them the application's plugins keep their
 * relative order instead of each one that requires a default sliding behind
 * independent plugins listed after it.
 *
 * @internal
 */
export function applicationPlugins(configured: readonly unknown[]): unknown[] {
  return [...defaultPluginsFor(configured), ...configured];
}

/**
 * Every shipped plugin's descriptor, for the root `craft()`'s catalogue.
 *
 * @internal
 */
export function shippedPlugins(): readonly Plugin[] {
  return [...shipped.values()].map(({ descriptor }) => descriptor);
}
