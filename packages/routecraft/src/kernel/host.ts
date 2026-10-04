import { isReservedFacet } from "./facets.ts";
import { rcError } from "../error.ts";
import {
  namespaceOf,
  type Plugin,
  type PluginContext,
  type PluginLogger,
  type PluginRoutes,
  type Execution,
} from "./plugin.ts";
import type { AnyPort, Port } from "./port.ts";
import type { EventDetailsMap, EventHandler, EventName } from "../types.ts";

/**
 * What the host needs from the application to build a plugin's context.
 * Supplied by `CraftContext`, which stays the runtime the routes run in.
 *
 * @internal
 */
export interface HostEnvironment {
  readonly logger: PluginLogger;
  readonly routes: PluginRoutes;
  readonly execution: Execution;
  observe<K extends EventName>(
    event: K | "*",
    handler: EventHandler<K>,
  ): () => void;
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
}

/**
 * One plugin as the kernel holds it: its descriptor, where it sits in the
 * order, what it declared, and what it has done so far.
 *
 * @internal
 */
export interface InstalledPlugin {
  readonly plugin: Plugin;
  /**
   * The id this install answers to: the plugin's own, or `id#n` for the
   * n-th install of a repeatable plugin.
   */
  readonly id: string;
  /** Position in dependency order. */
  readonly index: number;
  readonly namespace: string;
  readonly requires: ReadonlySet<symbol>;
  readonly optional: ReadonlySet<symbol>;
  readonly provides: ReadonlySet<symbol>;
  bound: boolean;
  started: boolean;
  readonly disposers: Array<() => void | Promise<void>>;
  context?: PluginContext;
}

interface Provision {
  readonly port: AnyPort;
  readonly provider: InstalledPlugin | undefined;
  value: unknown;
  provided: boolean;
}

function isPort(value: unknown): value is AnyPort {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AnyPort).name === "string" &&
    typeof (value as AnyPort).key === "symbol"
  );
}

function invalidPlugin(where: string, why: string): never {
  throw rcError("RC1117", undefined, {
    message: `Invalid plugin ${where}: ${why}. A plugin is a descriptor built with definePlugin({ id, bind?, start?, stop? }).`,
  });
}

function validateShape(plugin: unknown, where: string): Plugin {
  if (typeof plugin !== "object" || plugin === null) {
    invalidPlugin(where, "expected an object");
  }
  const p = plugin as Plugin & { apply?: unknown };
  if (typeof p.id !== "string" || p.id.length === 0) {
    invalidPlugin(
      where,
      typeof p.apply === "function"
        ? "it has apply(ctx), the pre-0.8 shape; declare an id and move apply into bind(c)"
        : "missing a non-empty string id",
    );
  }
  for (const hook of ["bind", "start", "stop"] as const) {
    if (p[hook] !== undefined && typeof p[hook] !== "function") {
      invalidPlugin(where, `${hook} must be a function`);
    }
  }
  if (p.facet !== undefined && typeof p.facet !== "function") {
    invalidPlugin(where, "facet must be a function");
  }
  if (
    p.steps !== undefined &&
    (typeof p.steps !== "object" ||
      p.steps === null ||
      !Object.values(p.steps).every((f) => typeof f === "function"))
  ) {
    invalidPlugin(where, "steps must be an object of step factories");
  }
  for (const field of [
    "requires",
    "optional",
    "provides",
    "replaces",
  ] as const) {
    const ports = p[field];
    if (ports === undefined) continue;
    if (!Array.isArray(ports) || !ports.every(isPort)) {
      invalidPlugin(where, `${field} must be an array of ports`);
    }
  }
  if (p.installs !== undefined && !Array.isArray(p.installs)) {
    invalidPlugin(where, "installs must be an array of plugins");
  }
  if (p.repeatable !== undefined && typeof p.repeatable !== "boolean") {
    invalidPlugin(where, "repeatable must be a boolean");
  }
  if (p.repeatable === true) {
    const declared = (
      [
        ["provides", p.provides?.length ?? 0],
        ["replaces", p.replaces?.length ?? 0],
        ["hooks", p.hooks === undefined ? 0 : Object.keys(p.hooks).length],
        ["points", p.points?.length ?? 0],
        ["steps", p.steps === undefined ? 0 : Object.keys(p.steps).length],
        ["a facet", p.facet === undefined ? 0 : 1],
      ] as const
    ).find(([, count]) => count > 0);
    if (declared) {
      invalidPlugin(
        where,
        `"${p.id}" is repeatable and declares ${declared[0]}, which every install would declare again; contribute through a port another plugin provides`,
      );
    }
  }
  return p;
}

/**
 * Every plugin a list installs, brought plugins included, in install order.
 * What a project's step catalogue is built from, so it holds exactly the
 * steps its application will install.
 *
 * @internal
 */
export function installedPlugins(plugins: readonly unknown[]): Plugin[] {
  return expand(
    plugins.map((plugin, index) => validateShape(plugin, `at index ${index}`)),
  );
}

/**
 * The listed plugins with everything they bring along, each brought plugin
 * placed ahead of the first plugin that brings it. An id the application
 * lists itself is never brought: the application's own choice wins.
 */
function expand(listed: readonly Plugin[]): Plugin[] {
  const listedIds = new Set(listed.map((plugin) => plugin.id));
  const brought = new Set<string>();
  const result: Plugin[] = [];
  const bring = (by: Plugin): void => {
    for (const raw of by.installs ?? []) {
      const plugin = validateShape(raw, `installed by "${by.id}"`);
      if (listedIds.has(plugin.id) || brought.has(plugin.id)) continue;
      brought.add(plugin.id);
      bring(plugin);
      result.push(plugin);
    }
  };
  for (const plugin of listed) {
    bring(plugin);
    result.push(plugin);
  }
  return result;
}

interface Identified {
  readonly plugin: Plugin;
  readonly id: string;
  readonly namespace: string;
}

/**
 * Number the installs of each repeatable plugin in list order.
 *
 * @throws RC1101 when one id is installed both repeatable and not
 */
function identify(plugins: readonly Plugin[]): Identified[] {
  const single = new Set(
    plugins.filter((p) => p.repeatable !== true).map((p) => p.id),
  );
  const installs = new Map<string, number>();
  return plugins.map((plugin) => {
    if (plugin.repeatable !== true) {
      return { plugin, id: plugin.id, namespace: namespaceOf(plugin) };
    }
    if (single.has(plugin.id)) {
      throw rcError("RC1101", undefined, {
        message: `The id "${plugin.id}" is installed both as a repeatable plugin and as a single one. Give the single one an id of its own.`,
      });
    }
    const n = (installs.get(plugin.id) ?? 0) + 1;
    installs.set(plugin.id, n);
    return {
      plugin,
      id: `${plugin.id}#${n}`,
      namespace: `${namespaceOf(plugin)}#${n}`,
    };
  });
}

/**
 * Installs a set of plugins: checks identity, resolves every port to one
 * provider, orders the plugins by what they require, then builds each one's
 * context and holds the port values while the application runs.
 *
 * Everything that can go wrong on the way to running throws a fault naming
 * the plugin responsible, before any plugin binds.
 *
 * @internal Driven by `CraftContext`.
 */
export class PluginHost {
  /** Plugins in dependency order. */
  readonly ordered: readonly InstalledPlugin[];
  private readonly provisions = new Map<symbol, Provision>();
  private frozen = false;

  /**
   * Every port a plugin selected itself for with `replaces`, so the
   * application can say at boot who decides what its defaults used to.
   */
  readonly replacements: {
    readonly port: AnyPort;
    readonly by: string;
    readonly displaced: readonly string[];
  }[] = [];

  constructor(plugins: readonly unknown[]) {
    const identified = identify(installedPlugins(plugins));
    this.checkIdentity(identified);
    const ports = this.collectPorts(identified.map(({ plugin }) => plugin));
    const installed = identified.map(
      ({ plugin, id, namespace }): InstalledPlugin => ({
        plugin,
        id,
        index: -1,
        namespace,
        requires: new Set((plugin.requires ?? []).map((p) => p.key)),
        optional: new Set((plugin.optional ?? []).map((p) => p.key)),
        provides: new Set((plugin.provides ?? []).map((p) => p.key)),
        bound: false,
        started: false,
        disposers: [],
      }),
    );
    this.resolve(installed, ports);
    this.ordered = this.order(installed).map((entry, index) =>
      Object.assign(entry, { index }),
    );
  }

  private checkIdentity(plugins: readonly Identified[]): void {
    const ids = new Map<string, number>();
    const namespaces = new Map<string, string>();
    plugins.forEach(({ plugin, id, namespace }, index) => {
      const seen = ids.get(id);
      if (seen !== undefined) {
        throw rcError("RC1101", undefined, {
          message: `Two plugins share the id "${id}" (positions ${seen} and ${index}). An id is installed once; a config key and an explicit plugin for the same feature count as two.`,
        });
      }
      ids.set(id, index);
      const owner = namespaces.get(namespace);
      if (owner !== undefined) {
        throw rcError("RC1102", undefined, {
          message: `Plugins "${owner}" and "${id}" both claim the namespace "${namespace}". Give one an explicit namespace.`,
        });
      }
      namespaces.set(namespace, id);
      if (plugin.facet !== undefined && isReservedFacet(namespace)) {
        throw rcError("RC1114", undefined, {
          message: `Plugin "${id}" declares a facet named "${namespace}", which every exchange already has. Give the plugin an explicit namespace.`,
        });
      }
    });
  }

  private collectPorts(plugins: readonly Plugin[]): Map<symbol, AnyPort> {
    const byName = new Map<string, AnyPort>();
    const byKey = new Map<symbol, AnyPort>();
    for (const plugin of plugins) {
      for (const field of [
        plugin.requires,
        plugin.optional,
        plugin.provides,
        plugin.replaces,
      ]) {
        for (const port of field ?? []) {
          const known = byName.get(port.name);
          if (known && known.key !== port.key) {
            throw rcError("RC1103", undefined, {
              message: `Two different tokens are named "${port.name}" (one reached through "${plugin.id}"). Two copies of the module declaring this port are loaded; deduplicate the dependency so every plugin shares one.`,
            });
          }
          byName.set(port.name, port);
          byKey.set(port.key, port);
        }
      }
    }
    return byKey;
  }

  private resolve(
    installed: readonly InstalledPlugin[],
    ports: ReadonlyMap<symbol, AnyPort>,
  ): void {
    for (const entry of installed) {
      for (const replaced of entry.plugin.replaces ?? []) {
        if (!entry.provides.has(replaced.key)) {
          throw rcError("RC1106", undefined, {
            message: `Plugin "${entry.id}" replaces "${replaced.name}" but does not list it in provides.`,
          });
        }
      }
    }
    for (const [key, port] of ports) {
      const providers = installed.filter((entry) => entry.provides.has(key));
      const replacers = providers.filter((entry) =>
        (entry.plugin.replaces ?? []).some((p) => p.key === key),
      );
      if (replacers.length > 1) {
        throw rcError("RC1106", undefined, {
          message: `Plugins ${replacers.map((r) => `"${r.id}"`).join(" and ")} both replace "${port.name}". Install one of them.`,
        });
      }
      if (replacers.length === 0 && providers.length > 1) {
        throw rcError("RC1105", undefined, {
          message: `Plugins ${providers.map((p) => `"${p.id}"`).join(" and ")} both provide "${port.name}" and neither declares replaces. Remove one, or declare replaces: [${port.name}] on the one that should be selected.`,
        });
      }
      const replacer = replacers[0];
      if (replacer) {
        this.replacements.push({
          port,
          by: replacer.id,
          displaced: providers
            .filter((entry) => entry !== replacer)
            .map((entry) => entry.id),
        });
      }
      this.provisions.set(key, {
        port,
        provider: replacer ?? providers[0],
        value: undefined,
        provided: false,
      });
    }
    for (const entry of installed) {
      for (const required of entry.plugin.requires ?? []) {
        if (!this.provisions.get(required.key)?.provider) {
          throw rcError("RC1104", undefined, {
            message: `Plugin "${entry.id}" requires "${required.name}", which no installed plugin provides.`,
          });
        }
      }
    }
  }

  /**
   * Topological order over requires and optional edges. Ties keep the order
   * the plugins were installed in, so the order an application lists is the
   * order it gets wherever dependencies allow.
   *
   * A repeatable plugin only contributes through the ports it uses, so it
   * also binds ahead of every other consumer of those ports: a plugin that
   * reads what was contributed (ACP building a route per registered agent)
   * then sees every contribution, wherever the application listed it.
   */
  private order(installed: readonly InstalledPlugin[]): InstalledPlugin[] {
    const uses = (entry: InstalledPlugin): symbol[] => [
      ...entry.requires,
      ...entry.optional,
    ];
    const dependsOn = new Map<InstalledPlugin, Set<InstalledPlugin>>();
    for (const entry of installed) {
      const deps = new Set<InstalledPlugin>();
      for (const key of uses(entry)) {
        const provider = this.provisions.get(key)?.provider;
        if (provider && provider !== entry) deps.add(provider);
      }
      dependsOn.set(entry, deps);
    }
    const contributors = installed.filter((entry) => entry.plugin.repeatable);
    for (const entry of installed) {
      if (entry.plugin.repeatable) continue;
      const deps = dependsOn.get(entry)!;
      for (const key of uses(entry)) {
        if (this.provisions.get(key)?.provider === entry) continue;
        for (const contributor of contributors) {
          if (!uses(contributor).includes(key)) continue;
          if (dependsOn.get(contributor)!.has(entry)) continue;
          deps.add(contributor);
        }
      }
    }
    const done = new Set<InstalledPlugin>();
    const result: InstalledPlugin[] = [];
    while (result.length < installed.length) {
      const next = installed.find(
        (entry) =>
          !done.has(entry) &&
          [...dependsOn.get(entry)!].every((dep) => done.has(dep)),
      );
      if (!next) {
        const edges = installed
          .filter((entry) => !done.has(entry))
          .flatMap((entry) =>
            [...dependsOn.get(entry)!]
              .filter((dep) => !done.has(dep))
              .map((dep) => `${entry.id} -> ${dep.id}`),
          );
        throw rcError("RC1107", undefined, {
          message: `The plugins depend on each other in a cycle: ${edges.join(", ")}.`,
        });
      }
      done.add(next);
      result.push(next);
    }
    return result;
  }

  /** Stop accepting contributions: the last `bind` has returned. */
  freeze(): void {
    this.frozen = true;
  }

  /** Whether the application froze. */
  get isFrozen(): boolean {
    return this.frozen;
  }

  private refuseWhenFrozen(plugin: string, what: string): void {
    if (this.frozen) {
      throw rcError("RC1110", undefined, {
        message: `Plugin "${plugin}" tried to ${what} after the application froze. Do it in bind(c), which runs before any route compiles.`,
      });
    }
  }

  /**
   * The provider of a port, for the kernel and for adapters at runtime.
   *
   * @throws RC1104 when nobody provides it
   */
  require<T>(port: Port<T>, asker = "the application"): T {
    const provision = this.provisions.get(port.key);
    if (!provision?.provided) {
      throw rcError("RC1104", undefined, {
        message: `${asker} needs "${port.name}", which no installed plugin provides.`,
      });
    }
    return provision.value as T;
  }

  /** Like {@link require}, but `undefined` when nobody provides it. */
  lookup<T>(port: Port<T>): T | undefined {
    const provision = this.provisions.get(port.key);
    return provision?.provided ? (provision.value as T) : undefined;
  }

  /** Whether any installed plugin provides the port, bound or not. */
  isProvided(port: AnyPort): boolean {
    return this.provisions.get(port.key)?.provider !== undefined;
  }

  /**
   * Refuse a plugin whose `bind` returned without providing every port it
   * declared.
   *
   * @throws RC1109
   */
  assertProvided(entry: InstalledPlugin): void {
    for (const key of entry.provides) {
      const provision = this.provisions.get(key);
      if (provision?.provider === entry && !provision.provided) {
        throw rcError("RC1109", undefined, {
          message: `Plugin "${entry.id}" declares it provides "${provision.port.name}" but its bind did not call c.provide() for it.`,
        });
      }
    }
  }

  /** The context a plugin's hooks receive. Built once per plugin. */
  contextFor(entry: InstalledPlugin, env: HostEnvironment): PluginContext {
    if (entry.context) return entry.context;
    const id = entry.id;
    const declared = (key: symbol): boolean =>
      entry.requires.has(key) || entry.optional.has(key);
    const requirePort = <T>(port: Port<T>): T =>
      this.require(port, `Plugin "${id}"`);
    const lookupPort = <T>(port: Port<T>): T | undefined => this.lookup(port);
    const refuseWhenFrozen = (what: string): void =>
      this.refuseWhenFrozen(id, what);
    const provisions = this.provisions;
    const isFrozen = (): boolean => this.frozen;
    const context: PluginContext = {
      id,
      namespace: entry.namespace,
      logger: env.logger.child({ plugin: id }),
      require<T>(port: Port<T>): T {
        if (!declared(port.key)) {
          throw rcError("RC1108", undefined, {
            message: `Plugin "${id}" required "${port.name}" without declaring it in requires or optional.`,
          });
        }
        return requirePort(port);
      },
      lookup<T>(port: Port<T>): T | undefined {
        if (!declared(port.key)) {
          throw rcError("RC1108", undefined, {
            message: `Plugin "${id}" looked up "${port.name}" without declaring it in requires or optional.`,
          });
        }
        return lookupPort(port);
      },
      provide<T>(port: Port<T>, value: T): void {
        if (!entry.provides.has(port.key)) {
          throw rcError("RC1109", undefined, {
            message: `Plugin "${id}" provided "${port.name}" without declaring it in provides.`,
          });
        }
        refuseWhenFrozen(`provide "${port.name}"`);
        const provision = provisions.get(port.key)!;
        // A displaced provider still binds and provides; its value is simply
        // not the one selected, so its own code keeps working unchanged.
        if (provision.provider !== entry) return;
        provision.value = value;
        provision.provided = true;
      },
      // Released at stop with the plugin's disposers, so a subscription
      // never outlives the plugin that made it.
      observe: (event, handler) => {
        const off = env.observe(event, handler);
        entry.disposers.push(off);
        return off;
      },
      emit: (event, details) => env.emit(event, details),
      onDispose(dispose) {
        entry.disposers.push(dispose);
      },
      routes: {
        register(...definitions) {
          refuseWhenFrozen("register routes");
          env.routes.register(...definitions);
        },
        list: () => env.routes.list(),
        get: (routeId) => env.routes.get(routeId),
      },
      execution: env.execution,
      get frozen() {
        return isFrozen();
      },
    };
    entry.context = context;
    return context;
  }
}
