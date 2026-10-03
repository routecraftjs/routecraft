import type { CraftContext } from "../context.ts";
import type { Capability } from "../capabilities.ts";
import type { ExchangeHeaders } from "../exchange.ts";
import type { logger } from "../logger.ts";
import type { RouteDefinition } from "../route.ts";
import type { EventDetailsMap, EventHandler, EventName } from "../types.ts";
import type { AnyPort, Port } from "./port.ts";
import type { Hooks, PointDeclaration } from "./hooks.ts";

/** The logger every plugin context carries. */
export type PluginLogger = ReturnType<typeof logger.child>;

/**
 * How far the application got, handed to every {@link Plugin.stop}.
 *
 * A stop runs on three shapes of application: one that started and is
 * stopping, one whose bind failed partway, and one whose start failed partway.
 * A plugin that only releases what `bind` acquired can ignore this; one that
 * stops what `start` began reads `started`.
 */
export interface StopInfo {
  /**
   * The application never fully started: a bind failed, a start failed, or an
   * embedder stopped a context it never started. Later plugins may never have
   * bound.
   */
  readonly partial: boolean;
  /** THIS plugin's own `start` returned. Always false without a `start`. */
  readonly started: boolean;
}

/**
 * A read-only view of a registered route, for plugins that list or report
 * routes (ops, MCP, ACP). The live route object is not handed out: it carries
 * the context, and a plugin is not given the context.
 */
export interface RouteView {
  readonly id: string;
  readonly definition: Readonly<RouteDefinition>;
  /** False while the route's `.enabled()` predicate holds it back. */
  readonly enabled: boolean;
  /** Why it is disabled, when it is. */
  readonly disabledReason?: string;
}

/** The routes surface of a {@link PluginContext}. */
export interface PluginRoutes {
  /**
   * Add routes this plugin contributes. In `bind` only: a route registered
   * after the application froze would miss compilation (`RC1110`).
   */
  register(...definitions: RouteDefinition[]): void;
  /** Every registered route. */
  list(): readonly RouteView[];
  /** One route by id. */
  get(id: string): RouteView | undefined;
}

/**
 * The verbs every plugin is handed to drive the application, ours and yours
 * alike. Execution is a socket: the same reach for every plugin.
 */
export interface Execution {
  /**
   * Hand a body to the route listening on a `direct()` endpoint and resolve
   * with its reply.
   *
   * @throws RC5004 when no route listens on the endpoint
   */
  deliver<R = unknown>(
    endpoint: string,
    body: unknown,
    headers?: ExchangeHeaders,
  ): Promise<R>;
  /** Discoverable capabilities of the enabled routes. */
  capabilities(): Capability[];
  /** Resolves once every route signalled readiness and every start returned. */
  whenStarted(): Promise<void>;
  /**
   * Ask the application to stop. Never awaited from a lifecycle hook: the
   * stop waits for the hook, so awaiting it from one never settles.
   */
  requestStop(): void;
}

/**
 * What `bind`, `start` and `stop` receive. Never the `CraftContext`: a plugin
 * reaches the application through ports, events, its routes and execution,
 * which is exactly the reach a third-party plugin has.
 */
export interface PluginContext {
  readonly id: string;
  readonly namespace: string;
  readonly logger: PluginLogger;
  /**
   * The provider of a port this plugin declared in `requires` or `optional`.
   *
   * @throws RC1108 when the port is not declared
   * @throws RC1104 when it is declared optional and nobody provides it
   */
  require<T>(port: Port<T>): T;
  /** Like {@link require}, but `undefined` when an optional port is absent. */
  lookup<T>(port: Port<T>): T | undefined;
  /**
   * Provide a port this plugin declared in `provides`. In `bind` only.
   *
   * @throws RC1109 when the port is not declared
   * @throws RC1110 after the application froze
   */
  provide<T>(port: Port<T>, value: T): void;
  /** Subscribe to an event, or `"*"` for all. Returns the unsubscribe. */
  observe<K extends EventName>(
    event: K | "*",
    handler: EventHandler<K>,
  ): () => void;
  /** Emit an event. */
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
  /**
   * Release something at stop. Run in reverse registration order, after this
   * plugin's own `stop`, every one even when another throws.
   */
  onDispose(dispose: () => void | Promise<void>): void;
  readonly routes: PluginRoutes;
  readonly execution: Execution;
  /**
   * The host context, for plugins not yet moved onto ports.
   *
   * @internal Staging only: removed before 0.8 ships, once every first-party
   *   plugin reaches what it needs through ports.
   */
  readonly context: CraftContext;
}

/**
 * A plugin: a plain descriptor the kernel installs, orders, binds, starts and
 * stops. Ours and yours have the same shape and the same reach.
 */
export interface Plugin {
  /** Dotted identity, unique per application: `routecraft.deferral`, `acme.approvals`. */
  readonly id: string;
  /**
   * The prefix this plugin's strings live under: its facet, its route
   * options, its events. Defaults to the last segment of {@link Plugin.id};
   * unique per application.
   */
  readonly namespace?: string;
  /** Ports this plugin cannot run without. A missing provider is `RC1104`. */
  readonly requires?: readonly AnyPort[];
  /** Ports this plugin uses when present. */
  readonly optional?: readonly AnyPort[];
  /** Ports this plugin provides in `bind`. */
  readonly provides?: readonly AnyPort[];
  /**
   * Ports whose other provider this plugin displaces. It must also list them
   * in `provides`. The displaced plugin still binds; its provision of the
   * port is not the one selected.
   */
  readonly replaces?: readonly AnyPort[];
  /**
   * The plugin owns a lifetime past the routes (a listener, a subscription):
   * when every route has completed the application keeps running until
   * stopped.
   */
  readonly keepsAlive?: boolean;
  /**
   * Handlers and wrappers in the chain's slots, each with a phase; or hooks
   * at a point another plugin declares. Placed when the application freezes.
   * A hook names a slot and a phase, never another plugin.
   */
  readonly hooks?: Hooks;
  /**
   * Moments this plugin declares and invokes from its own steps
   * (`ctx.invoke(name, exchange)`), where other plugins add hooks.
   */
  readonly points?: readonly PointDeclaration[];
  /** Require, provide, observe, register routes. Runs in dependency order. */
  bind?(context: PluginContext): void | Promise<void>;
  /**
   * Begin work that needs running routes. Awaited; bounded work only, see
   * the plugin lifecycle standard. A throw fails the start and unwinds.
   */
  start?(context: PluginContext): void | Promise<void>;
  /** Release what `bind` and `start` acquired. Reverse order. */
  stop?(context: PluginContext, info: StopInfo): void | Promise<void>;
}

/**
 * Declare a plugin. An identity function that keeps the descriptor's literal
 * types, so a project built from it is typed by exactly what it declares.
 *
 * @param plugin - The descriptor
 * @returns The same descriptor
 *
 * @example
 * ```ts
 * export const audit = definePlugin({
 *   id: "acme.audit",
 *   bind(c) {
 *     c.observe("route:exchange:failed", ({ details }) => record(details));
 *   },
 * });
 * ```
 */
export function definePlugin<const P extends Plugin>(plugin: P): P {
  return plugin;
}

/**
 * The namespace a plugin's strings live under.
 *
 * @internal
 */
export function namespaceOf(plugin: Pick<Plugin, "id" | "namespace">): string {
  return plugin.namespace ?? plugin.id.slice(plugin.id.lastIndexOf(".") + 1);
}
