import type { Plugin } from "./plugin.ts";

const REGISTRY_KEY: unique symbol = Symbol.for(
  "routecraft.default-plugin-registry",
);

type GlobalWithDefaults = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, () => Plugin>;
};

function registry(): Map<string, () => Plugin> {
  const g = globalThis as GlobalWithDefaults;
  return (g[REGISTRY_KEY] ??= new Map());
}

/**
 * Install a plugin in every application unless the application installs its
 * own plugin with the same id.
 *
 * How the framework's own positions get their providers without the kernel
 * importing a plugin: each default plugin's module registers itself when the
 * package entry loads. A default is a default because it is installed by
 * default, not because the kernel knows its name; replacing what it provides
 * is the ordinary `replaces` declaration.
 *
 * Keyed on `Symbol.for` so two copies of the package in one process share
 * one registry rather than installing every default twice.
 *
 * @param id - The plugin id, which an application overrides by installing
 *   a plugin with the same id
 * @param factory - Builds a fresh descriptor per application
 */
export function registerDefaultPlugin(id: string, factory: () => Plugin): void {
  registry().set(id, factory);
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
  return [...registry()]
    .filter(([id]) => !ids.has(id))
    .map(([, factory]) => factory());
}
