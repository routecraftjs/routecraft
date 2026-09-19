import type {
  Contribution,
  EventHandler,
  EventName,
  Health,
  Plugin,
  PluginContext,
  Registration,
  Token,
} from "../contracts/index.ts";
import { EventBus } from "../events/index.ts";
import { InterventionRegistry } from "../interventions/index.ts";
import { ServiceRegistry } from "../registry/index.ts";
import { topoSort } from "./graph.ts";

/**
 * The plugin host. Reads the plugin list, sorts by `dependsOn`, runs
 * apply then start, aggregates health, and tears down in reverse.
 *
 * It cannot itself be a plugin: the thing that loads plugins cannot be
 * loaded by the thing that loads plugins. That bootstrap argument is the
 * test for what belongs in core.
 */
export class Kernel {
  readonly services = new ServiceRegistry();
  readonly interventions = new InterventionRegistry();
  readonly events = new EventBus();

  readonly #plugins: Plugin[];
  readonly #applied: Plugin[] = [];
  readonly #teardowns: Array<() => void | Promise<void>> = [];
  #started = false;

  constructor(plugins: readonly Plugin[]) {
    this.#plugins = topoSort(
      plugins.map((p) => ({ id: p.id, after: p.dependsOn ?? [], plugin: p })),
      { requireAll: true },
    ).map((n) => n.plugin);
  }

  /** Install order after the dependency sort, for assertions and logs. */
  get order(): readonly string[] {
    return this.#plugins.map((p) => p.id);
  }

  async start(): Promise<void> {
    for (const plugin of this.#plugins) {
      await plugin.apply?.(this.#contextFor(plugin));
      this.#applied.push(plugin);
    }
    this.interventions.freeze();
    for (const plugin of this.#applied) {
      await plugin.start?.(this.#contextFor(plugin));
    }
    this.#started = true;
    this.events.emit("kernel:started", { plugins: this.order });
  }

  async health(): Promise<Record<string, Health>> {
    const out: Record<string, Health> = {};
    for (const plugin of this.#applied) {
      out[plugin.id] = (await plugin.health?.()) ?? { up: true };
    }
    return out;
  }

  async stop(): Promise<void> {
    for (const fn of [...this.#teardowns].reverse()) await fn();
    for (const plugin of [...this.#applied].reverse()) {
      await plugin.stop?.(this.#contextFor(plugin));
    }
    this.#started = false;
    this.events.emit("kernel:stopped", {});
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Arrow properties rather than shorthand methods so `this` stays the
   * kernel without aliasing it into a local.
   */
  #contextFor(plugin: Plugin): PluginContext {
    return {
      id: plugin.id,
      provide: <T>(token: Token<T>, value: T): void => {
        this.services.provide(token, value, plugin.id);
      },
      require: <T>(token: Token<T>): T =>
        this.services.require(token, plugin.id),
      optional: <T>(token: Token<T>): T | undefined =>
        this.services.optional(token),
      on: (event: EventName, handler: EventHandler): Registration =>
        this.events.on(event, handler),
      contribute: (contribution: Contribution): void => {
        this.interventions.add(contribution, plugin.id);
      },
      onTeardown: (fn: () => void | Promise<void>): void => {
        this.#teardowns.push(fn);
      },
    };
  }
}
