import {
  Fault,
  fault,
  type Installation,
  type Execution,
  type PluginContext,
  type AnyPort,
  type Port,
  type Contribution,
  type Ordered,
} from "./contracts.ts";
import { sort } from "./graph.ts";
export type Owned<T> = T & { readonly owner: string };
/** Snapshot descriptors, preserving contract identities and executable functions. */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, snapshot(v)]),
      ),
    ) as T;
  return value;
}
export class Host {
  #execution: Execution | undefined;
  connect(execution: Execution) {
    if (this.#phase !== "new") throw new Fault("kernel", "FROZEN", "execution");
    this.#execution = execution;
  }
  readonly faults: Fault[] = [];
  readonly ignored: string[] = [];
  readonly selected = new Map<
    symbol,
    { port: AnyPort; plugin: Installation }
  >();
  readonly order: readonly Installation[];
  readonly #values = new Map<symbol, unknown>();
  readonly #contributions: Owned<Contribution>[] = [];
  readonly #observers = new Set<{
    owner: string;
    fn: (event: Readonly<{ name: string; data: unknown }>) => unknown;
  }>();
  readonly #applied: {
    plugin: Installation;
    ctx: PluginContext;
    cleanup: (() => void | Promise<void>)[];
  }[] = [];
  #phase:
    | "new"
    | "binding"
    | "bound"
    | "starting"
    | "running"
    | "stopping"
    | "stopped" = "new";
  constructor(plugins: readonly Installation[]) {
    const ids = new Set<string>();
    const names = new Map<string, symbol>();
    for (const p of plugins) {
      if (ids.has(p.id)) throw new Fault(p.id, "DUPLICATE_ID", p.id);
      ids.add(p.id);
      for (const t of [...(p.requires ?? []), ...(p.provides ?? [])]) {
        const prior = names.get(t.name);
        if (prior && prior !== t.key)
          throw new Fault(
            p.id,
            "PORT_IDENTITY",
            `${t.name}: duplicate contract module or independently created token`,
          );
        names.set(t.name, t.key);
      }
      for (const t of p.replaces ?? [])
        if (!p.provides?.some((x) => x.key === t.key))
          throw new Fault(p.id, "INVALID_REPLACEMENT", t.name);
    }
    const candidates = new Map<
      symbol,
      { port: AnyPort; plugins: Installation[] }
    >();
    for (const p of plugins)
      for (const t of p.provides ?? []) {
        const c = candidates.get(t.key) ?? { port: t, plugins: [] };
        c.plugins.push(p);
        candidates.set(t.key, c);
      }
    for (const [key, c] of candidates) {
      const replacements = c.plugins.filter((p) =>
        p.replaces?.some((t) => t.key === key),
      );
      if (
        c.plugins.length > 1 &&
        (replacements.length !== 1 || c.plugins.length !== 2)
      )
        throw new Fault(
          c.plugins.map((p) => p.id).join(", "),
          "DUPLICATE_PROVIDER",
          c.port.name,
        );
      this.selected.set(key, {
        port: c.port,
        plugin: replacements[0] ?? c.plugins[0]!,
      });
    }
    this.order = sort(
      plugins.map((p) => ({
        id: p.id,
        plugin: p,
        after: [
          ...new Set(
            (p.requires ?? []).map((t) => {
              const provider = this.selected.get(t.key);
              if (!provider) throw new Fault(p.id, "MISSING_PORT", t.name);
              return provider.plugin.id;
            }),
          ),
        ].filter((x) => x !== p.id),
      })),
    ).map((n) => n.plugin);
  }
  get phase() {
    return this.#phase;
  }
  get contributions(): readonly Owned<Contribution>[] {
    return this.#contributions;
  }
  service<T>(t: Port<T>): T {
    if (!this.#values.has(t.key))
      throw new Fault("kernel", "UNAVAILABLE_PORT", t.name);
    return this.#values.get(t.key) as T;
  }
  has(t: AnyPort) {
    return this.#values.has(t.key);
  }
  async bind() {
    if (this.#phase !== "new")
      throw new Fault("kernel", "LIFECYCLE", this.#phase);
    this.#phase = "binding";
    try {
      for (const plugin of this.order) {
        const cleanup: (() => void | Promise<void>)[] = [];
        const requireExecution = () => {
          if (!this.#execution)
            throw new Fault(
              plugin.id,
              "EXECUTION_UNAVAILABLE",
              "host not attached",
            );
          return this.#execution;
        };
        const ctx: PluginContext = {
          id: plugin.id,
          get execution() {
            return requireExecution();
          },
          require: <T>(t: Port<T>): T => {
            if (!plugin.requires?.some((x) => x.key === t.key))
              throw new Fault(plugin.id, "UNDECLARED_REQUIRE", t.name);
            try {
              return this.service(t);
            } catch (e) {
              throw fault(plugin.id, "REQUIRE", e);
            }
          },
          provide: <T>(t: Port<T>, value: T) => {
            if (this.#phase !== "binding")
              throw new Fault(plugin.id, "FROZEN", "provide");
            if (!plugin.provides?.some((x) => x.key === t.key))
              throw new Fault(plugin.id, "UNDECLARED_PROVIDE", t.name);
            if (this.selected.get(t.key)?.plugin !== plugin) return;
            if (this.#values.has(t.key))
              throw new Fault(plugin.id, "DUPLICATE_PROVIDE", t.name);
            this.#values.set(t.key, value);
          },
          onDispose: (fn) => {
            if (this.#phase === "stopped" || this.#phase === "stopping")
              throw new Fault(plugin.id, "LIFECYCLE", "late disposer");
            cleanup.push(fn);
          },
          observe: (fn) => {
            const entry = { owner: plugin.id, fn };
            this.#observers.add(entry);
            cleanup.push(() => {
              this.#observers.delete(entry);
            });
          },
          contribute: (c) => {
            if (this.#phase !== "binding")
              throw new Fault(plugin.id, "FROZEN", c.id);
            const previous = this.#contributions.find((x) => x.id === c.id);
            if (previous)
              throw new Fault(
                plugin.id,
                "DUPLICATE_CONTRIBUTION",
                `${c.id} already owned by ${previous.owner}`,
              );
            this.#contributions.push(snapshot({ ...c, owner: plugin.id }));
          },
        };
        // Register BEFORE acquisition: partial acquisition owns cleanup too.
        this.#applied.push({ plugin, ctx, cleanup });
        try {
          await plugin.bind?.(ctx);
        } catch (e) {
          throw fault(plugin.id, "BIND", e);
        }
      }
      for (const [key, p] of this.selected)
        if (!this.#values.has(key))
          throw new Fault(p.plugin.id, "UNPROVIDED_PORT", p.port.name);
      this.ordered(this.#contributions);
      this.#phase = "bound";
    } catch (e) {
      const primary = fault("kernel", "BOOT", e);
      primary.secondary.push(...(await this.dispose()));
      throw primary;
    }
  }
  async activate() {
    if (this.#phase !== "bound")
      throw new Fault("kernel", "LIFECYCLE", this.#phase);
    this.#phase = "starting";
    try {
      for (const { plugin, ctx } of this.#applied) {
        try {
          await plugin.start?.(ctx);
        } catch (e) {
          throw fault(plugin.id, "START", e);
        }
      }
      this.#phase = "running";
    } catch (e) {
      const f = fault("kernel", "BOOT", e);
      // Runtime stops sources and drains active work before disposing bound resources.
      throw f;
    }
  }
  ordered<T extends Ordered & { owner: string }>(items: readonly T[]): T[] {
    const anchors = new Map<symbol, T>();
    for (const x of items)
      if (x.anchor) {
        if (!this.selected.has(x.anchor.port.key))
          throw new Fault(x.owner, "ANCHOR_OWNER", x.anchor.name);
        if (anchors.has(x.anchor.key))
          throw new Fault(
            x.owner,
            "DUPLICATE_ANCHOR",
            `${x.anchor.name}: ${anchors.get(x.anchor.key)!.owner}`,
          );
        anchors.set(x.anchor.key, x);
      }
    const nodes = items.map((x) => ({
      id: `${x.owner}/${x.id}`,
      after: [] as string[],
      item: x,
    }));
    for (const n of nodes)
      for (const side of ["before", "after"] as const)
        for (const edge of n.item[side] ?? []) {
          const target = anchors.get(edge.anchor.key);
          if (!target) {
            if (
              edge.presence === "required" ||
              this.selected.has(edge.anchor.port.key)
            )
              throw new Fault(n.item.owner, "MISSING_ANCHOR", edge.anchor.name);
            const message = `${n.item.owner}/${n.item.id}: absent optional ${edge.anchor.port.name}/${edge.anchor.name}`;
            if (!this.ignored.includes(message)) this.ignored.push(message);
            continue;
          }
          const id = `${target.owner}/${target.id}`;
          if (side === "after") n.after.push(id);
          else nodes.find((x) => x.id === id)!.after.push(n.id);
        }
    return sort(nodes).map((x) => x.item);
  }
  emit(name: string, data: unknown) {
    for (const observer of [...this.#observers]) {
      try {
        const value = observer.fn(
          Object.freeze({ name, data: structuredClone(data) }),
        );
        void Promise.resolve(value).catch((e) =>
          this.faults.push(fault(observer.owner, "OBSERVER", e)),
        );
      } catch (e) {
        this.faults.push(fault(observer.owner, "OBSERVER", e));
      }
    }
  }
  async dispose(): Promise<Fault[]> {
    if (this.#phase === "stopped") return [];
    this.#phase = "stopping";
    const errors: Fault[] = [];
    for (const { plugin, ctx, cleanup } of [...this.#applied].reverse()) {
      try {
        await plugin.stop?.(ctx);
      } catch (e) {
        errors.push(fault(plugin.id, "STOP", e));
      }
      for (const fn of [...cleanup].reverse())
        try {
          await fn();
        } catch (e) {
          errors.push(fault(plugin.id, "DISPOSE", e));
        }
    }
    this.#values.clear();
    this.#phase = "stopped";
    return errors;
  }
  dump() {
    return {
      phase: this.phase,
      order: this.order.map((p) => p.id),
      providers: [...this.selected.values()].map((x) => ({
        port: x.port.name,
        plugin: x.plugin.id,
        replacement:
          x.plugin.replaces?.some((t) => t.key === x.port.key) ?? false,
      })),
      contributions: this.ordered(this.#contributions).map((x) => ({
        id: x.id,
        owner: x.owner,
        kind: x.kind,
      })),
      unmatched: [...this.ignored],
    };
  }
}
