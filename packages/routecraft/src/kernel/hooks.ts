import { rcError } from "../error.ts";
import { DefaultExchange, type Exchange } from "../exchange.ts";
import type { ExchangeHeaders } from "../exchange.ts";
import { OperationType } from "../exchange.ts";
import type { ForwardFn } from "../route.ts";
import type { Adapter, Step } from "../types.ts";
import type { PluginLogger } from "./plugin.ts";

/**
 * The slots of the route chain, in order. Positions sit between them and
 * belong to the framework; a slot is where any number of plugins add.
 */
export const SLOTS = [
  "error",
  "beforeAuth",
  "afterAuth",
  "admitted",
  "perAttempt",
  "exit",
] as const;

/** A slot of the route chain. */
export type Slot = (typeof SLOTS)[number];

/** The slots that take exchange hooks, as opposed to wrappers or error hooks. */
export type ExchangeSlot = "beforeAuth" | "afterAuth" | "admitted" | "exit";

/** What a hook does, which decides when it runs inside its slot. */
export type Phase = "observe" | "mutate" | "validate";

/** The kinds of run an exchange can be in. */
export type RunKind = "normal" | "resume" | "debounce" | "errorChannel";

/** What a hook learns beside the exchange. */
export interface HookInfo {
  readonly routeId: string;
  readonly tags: readonly string[];
  /** The slot or point the hook is running in. */
  readonly slot: string;
  readonly kind: RunKind;
}

declare const REFUSAL: unique symbol;

/** A validate hook's refusal, built with {@link refuse}. */
export interface Refusal {
  readonly [REFUSAL]: true;
  readonly reason: string;
}

const REFUSALS = new WeakSet<object>();

/**
 * Refuse the exchange from a `validate` hook. The run fails with `RC5068`
 * naming the hook and the reason, and the failure reaches the `error` slot
 * like any other.
 *
 * @param reason - Why, in words an operator reads in the log
 * @returns The refusal to return from the hook
 */
export function refuse(reason: string): Refusal {
  const refusal = { reason } as Refusal;
  REFUSALS.add(refusal);
  return Object.freeze(refusal);
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && REFUSALS.has(value);
}

/** What a `mutate` hook may return: the headers to set and the body to replace. */
export interface ExchangePatch {
  readonly headers?: ExchangeHeaders;
  readonly body?: unknown;
}

interface HookBase {
  /**
   * The hook's name, which `hooks.order` and `hooks.disable` address as
   * `pluginId/name`. Defaults to the name of its function.
   */
  readonly id?: string;
  /** Only these routes. Combined with `tags` as alternatives. */
  readonly routes?: readonly string[];
  /** Only routes carrying one of these tags. */
  readonly tags?: readonly string[];
  /**
   * The kinds of run this hook applies to. Defaults to `normal` only.
   * `beforeAuth`, `afterAuth` and `admitted` see admitted traffic only, so
   * there a run kind other than `normal` never matches.
   */
  readonly runs?: readonly RunKind[];
}

/** An `observe` hook: reads, never changes. */
export interface ObserveHook extends HookBase {
  readonly phase: "observe";
  run(exchange: Exchange, info: HookInfo): void | Promise<void>;
}

/** A `mutate` hook: returns the headers and body it changes, or nothing. */
export interface MutateHook extends HookBase {
  readonly phase: "mutate";
  /**
   * The headers this hook writes. Declared, two hooks writing one header in
   * one slot are reported when the application starts rather than on the
   * first request that hits both.
   */
  readonly writes?: readonly string[];
  run(
    exchange: Exchange,
    info: HookInfo,
  ): ExchangePatch | void | Promise<ExchangePatch | void>;
}

/** A `validate` hook: allows by returning nothing, refuses with {@link refuse}. */
export interface ValidateHook extends HookBase {
  readonly phase: "validate";
  run(
    exchange: Exchange,
    info: HookInfo,
  ): Refusal | void | Promise<Refusal | void>;
}

/** A hook in an exchange slot or a declared point. */
export type ExchangeHook = ObserveHook | MutateHook | ValidateHook;

/**
 * A wrapper in the `perAttempt` slot. It surrounds every attempt of the
 * route's work, inside retry and outside timeout: it may time, trace or
 * guard an attempt, and it may throw, but it does not change the exchange.
 */
export interface WrapperHook extends HookBase {
  wrap(
    proceed: () => Promise<void>,
    exchange: Exchange,
    info: HookInfo,
  ): Promise<void>;
}

/** What an `error` hook learns beside the error and the exchange. */
export interface ErrorHookInfo extends HookInfo {
  /**
   * `1` on the exchange's first run, `2` once it is a resumed continuation.
   * A hook that parks on a failure reads this, or a failure the resume itself
   * causes parks the same exchange again and the human is asked twice.
   */
  readonly execution: 1 | 2;
  /** Send to a direct endpoint carrying the failing exchange's principal. */
  readonly forward: ForwardFn;
}

/**
 * A hook in the `error` slot. It hears every failure the route's own
 * `.error()` did not settle. In `observe` it only hears. In `mutate` it may
 * answer with a recovery body, `recovery.drop()`, `recovery.defer()` or
 * `recovery.rethrow()`; `undefined` passes to the next hook, and the first
 * answer decides.
 */
export interface ErrorHook extends HookBase {
  readonly phase: "observe" | "mutate";
  /**
   * This hook may answer with `recovery.defer()`. Declared rather than
   * detected because a hook is an opaque closure: it makes every route it
   * applies to deferrable, so the application refuses to start without a
   * deferral runtime.
   */
  readonly mayDefer?: boolean;
  run(
    error: unknown,
    exchange: Exchange,
    info: ErrorHookInfo,
  ): unknown | Promise<unknown>;
}

type OneOrMany<T> = T | readonly T[];

/** The hooks a plugin declares, keyed by slot or by a declared point. */
export interface Hooks {
  readonly error?: OneOrMany<ErrorHook>;
  readonly beforeAuth?: OneOrMany<ExchangeHook>;
  readonly afterAuth?: OneOrMany<ExchangeHook>;
  readonly admitted?: OneOrMany<ExchangeHook>;
  readonly perAttempt?: OneOrMany<WrapperHook>;
  readonly exit?: OneOrMany<ObserveHook | MutateHook>;
  /** A point another plugin declared. */
  readonly [point: string]: OneOrMany<unknown> | undefined;
}

/** A point a plugin declares and invokes from its own steps. */
export interface PointDeclaration {
  /** Dotted, under the declaring plugin's namespace: `approvals.decided`. */
  readonly name: string;
}

/** The application's say over the order and presence of hooks. */
export interface HooksConfig {
  /**
   * The exact order for one phase of one slot, by hook id
   * (`pluginId/name`), keyed `slot/phase`. Hooks it does not name run after
   * the named ones, in plugin order.
   */
  readonly order?: Readonly<Record<string, readonly string[]>>;
  /** Hooks switched off, by id. Slots only; a position is never disabled. */
  readonly disable?: readonly string[];
}

/**
 * One installed hook, resolved: its plugin, its id, where it runs.
 *
 * @internal
 */
export interface InstalledHook<H = ExchangeHook | WrapperHook | ErrorHook> {
  readonly pluginId: string;
  /** `pluginId/name`. */
  readonly id: string;
  readonly slot: string;
  readonly hook: H;
}

const PHASE_ORDER: readonly Phase[] = ["observe", "mutate", "validate"];

function hookName(hook: { id?: string }, fn: unknown, index: number): string {
  if (hook.id) return hook.id;
  const name = typeof fn === "function" ? fn.name : "";
  return name && name !== "run" && name !== "wrap" ? name : `hook${index}`;
}

function asList<T>(value: OneOrMany<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/**
 * Every hook every plugin declared, placed and checked once the application
 * froze, plus the per-route selection the executor reads.
 *
 * @internal
 */
export class HookTable {
  private readonly bySlot = new Map<string, InstalledHook[]>();
  private readonly points = new Map<string, string>();
  private readonly warned = new Set<string>();

  constructor(
    plugins: readonly {
      readonly id: string;
      readonly hooks?: Hooks;
      readonly points?: readonly PointDeclaration[];
    }[],
    private readonly config: HooksConfig,
    private readonly logger: PluginLogger,
  ) {
    for (const plugin of plugins) {
      for (const point of plugin.points ?? []) {
        if (SLOTS.includes(point.name as Slot)) {
          throw rcError("RC1113", undefined, {
            message: `Plugin "${plugin.id}" declares the point "${point.name}", which is a slot of the chain.`,
          });
        }
        const owner = this.points.get(point.name);
        if (owner !== undefined) {
          throw rcError("RC1113", undefined, {
            message: `Plugins "${owner}" and "${plugin.id}" both declare the point "${point.name}".`,
          });
        }
        this.points.set(point.name, plugin.id);
      }
    }
    for (const plugin of plugins) {
      for (const [slot, declared] of Object.entries(plugin.hooks ?? {})) {
        if (!SLOTS.includes(slot as Slot) && !this.points.has(slot)) {
          throw rcError("RC1112", undefined, {
            message: `Plugin "${plugin.id}" declares a hook in "${slot}", which is neither a slot of the chain (${SLOTS.join(", ")}) nor a point an installed plugin declares.`,
          });
        }
        asList(declared).forEach((hook, index) => {
          const h = hook as ExchangeHook & WrapperHook & ErrorHook;
          this.checkShape(plugin.id, slot, h);
          const fn = slot === "perAttempt" ? h.wrap : h.run;
          const id = `${plugin.id}/${hookName(h, fn, index)}`;
          const list = this.bySlot.get(slot) ?? [];
          if (list.some((existing) => existing.id === id)) {
            throw rcError("RC1112", undefined, {
              message: `Plugin "${plugin.id}" declares two hooks named "${id}" in "${slot}". Give one an explicit id.`,
            });
          }
          list.push({ pluginId: plugin.id, id, slot, hook: h });
          this.bySlot.set(slot, list);
        });
      }
    }
    this.checkConfig();
    this.reportDeclaredConflicts();
  }

  private checkShape(
    pluginId: string,
    slot: string,
    hook: Partial<ExchangeHook & WrapperHook & ErrorHook>,
  ): void {
    const where = `Plugin "${pluginId}" hook in "${slot}"`;
    if (slot === "perAttempt") {
      if (typeof hook.wrap !== "function") {
        throw rcError("RC1115", undefined, {
          message: `${where} must be a wrapper: { wrap(proceed, exchange, info) }.`,
        });
      }
      return;
    }
    if (typeof hook.run !== "function") {
      throw rcError("RC1115", undefined, {
        message: `${where} needs a run function.`,
      });
    }
    const allowed: readonly string[] =
      slot === "error"
        ? ["observe", "mutate"]
        : slot === "exit"
          ? ["observe", "mutate"]
          : PHASE_ORDER;
    if (!allowed.includes(hook.phase as string)) {
      throw rcError("RC1115", undefined, {
        message: `${where} declares phase "${String(hook.phase)}"; "${slot}" takes ${allowed.join(", ")}.`,
      });
    }
  }

  private checkConfig(): void {
    const known = new Set(
      [...this.bySlot.values()].flat().map((entry) => entry.id),
    );
    for (const id of this.config.disable ?? []) {
      if (!known.has(id)) {
        throw rcError("RC1112", undefined, {
          message: `hooks.disable names "${id}", which no installed plugin declares. Known hooks: ${[...known].join(", ") || "none"}.`,
        });
      }
    }
    for (const [key, ids] of Object.entries(this.config.order ?? {})) {
      const [slot, phase] = key.split("/");
      if (
        slot === undefined ||
        phase === undefined ||
        !PHASE_ORDER.includes(phase as Phase)
      ) {
        throw rcError("RC1112", undefined, {
          message: `hooks.order key "${key}" must be "slot/phase", e.g. "beforeAuth/mutate".`,
        });
      }
      for (const id of ids) {
        const entry = (this.bySlot.get(slot) ?? []).find((e) => e.id === id);
        if (!entry || (entry.hook as { phase?: string }).phase !== phase) {
          throw rcError("RC1112", undefined, {
            message: `hooks.order["${key}"] names "${id}", which is not a ${phase} hook in "${slot}".`,
          });
        }
      }
    }
  }

  /** Two mutate hooks declaring one header in one slot: the later wins, said now. */
  private reportDeclaredConflicts(): void {
    for (const [slot, entries] of this.bySlot) {
      const writers = new Map<string, string>();
      for (const entry of this.ordered(slot, "mutate")) {
        for (const header of (entry.hook as MutateHook).writes ?? []) {
          const earlier = writers.get(header);
          if (earlier !== undefined) {
            this.logger.warn(
              { slot, header, earlier, later: entry.id },
              `${slot}/mutate: ${earlier} and ${entry.id} both write ${header}; ${entry.id} wins (it runs later). Settle it with hooks.order or hooks.disable.`,
            );
          }
          writers.set(header, entry.id);
        }
      }
      void entries;
    }
  }

  /** Whether a point of this name was declared. */
  hasPoint(name: string): boolean {
    return this.points.has(name);
  }

  /**
   * The hooks of one phase of one slot, in effective order: the configured
   * order first, then the rest in plugin order, without disabled ones.
   */
  ordered(slot: string, phase?: Phase | "observe" | "mutate"): InstalledHook[] {
    const disabled = new Set(this.config.disable ?? []);
    const all = (this.bySlot.get(slot) ?? []).filter(
      (entry) =>
        !disabled.has(entry.id) &&
        (phase === undefined ||
          (entry.hook as { phase?: string }).phase === phase),
    );
    if (phase === undefined) return all;
    const preferred = this.config.order?.[`${slot}/${phase}`] ?? [];
    const head = preferred
      .map((id) => all.find((entry) => entry.id === id))
      .filter((entry): entry is InstalledHook => entry !== undefined);
    return [...head, ...all.filter((entry) => !head.includes(entry))];
  }

  /** The hooks of a slot that apply to one route, phase by phase. */
  forRoute(
    slot: string,
    routeId: string,
    tags: readonly string[],
  ): InstalledHook[] {
    const phases = slot === "perAttempt" ? [undefined] : PHASE_ORDER;
    return phases.flatMap((phase) =>
      this.ordered(slot, phase).filter((entry) =>
        appliesTo(entry.hook as HookBase, routeId, tags),
      ),
    );
  }

  /** Warn once per route, slot, header and pair when two mutate hooks collided at runtime. */
  warnCollision(
    routeId: string,
    slot: string,
    header: string,
    earlier: string,
    later: string,
  ): void {
    const key = `${routeId}\0${slot}\0${header}\0${earlier}\0${later}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(
      { route: routeId, slot, header, earlier, later },
      `${slot}/mutate: ${earlier} and ${later} both wrote ${header} on route "${routeId}"; ${later} wins (it runs later). Settle it with hooks.order or hooks.disable.`,
    );
  }
}

function appliesTo(
  hook: HookBase,
  routeId: string,
  tags: readonly string[],
): boolean {
  const byRoute = hook.routes;
  const byTag = hook.tags;
  if (byRoute === undefined && byTag === undefined) return true;
  return (
    (byRoute?.includes(routeId) ?? false) ||
    (byTag?.some((tag) => tags.includes(tag)) ?? false)
  );
}

/** Whether a hook applies to a kind of run. */
export function runsOn(
  hook: { runs?: readonly RunKind[] },
  kind: RunKind,
): boolean {
  return (hook.runs ?? ["normal"]).includes(kind);
}

/**
 * Run the exchange hooks of one slot or point over an exchange, phase by
 * phase, and return the exchange as the last mutate left it.
 *
 * @throws RC5068 when a validate hook refuses; RC1115 when a hook breaks its phase
 * @internal
 */
export async function runExchangeHooks(
  table: HookTable,
  hooks: readonly InstalledHook[],
  exchange: Exchange,
  info: HookInfo,
): Promise<Exchange> {
  let current = exchange;
  const wroteBy = new Map<string, string>();
  for (const entry of hooks) {
    const hook = entry.hook as ExchangeHook;
    if (!runsOn(hook, info.kind)) continue;
    const result = await hook.run(current, info);
    if (hook.phase === "observe") {
      if (result !== undefined) {
        throw rcError("RC1115", undefined, {
          message: `Observe hook ${entry.id} in "${info.slot}" returned a value. An observe hook reads; change the exchange from a mutate hook.`,
        });
      }
      continue;
    }
    if (hook.phase === "validate") {
      if (result === undefined) continue;
      if (isRefusal(result)) {
        throw rcError("RC5068", undefined, {
          message: `${entry.id} refused the exchange in "${info.slot}": ${result.reason}`,
        });
      }
      throw rcError("RC1115", undefined, {
        message: `Validate hook ${entry.id} in "${info.slot}" returned something other than a refusal. A validate hook allows by returning nothing and refuses with refuse(reason); it never changes the exchange.`,
      });
    }
    if (result === undefined) continue;
    const patch = result as ExchangePatch;
    for (const header of Object.keys(patch.headers ?? {})) {
      const earlier = wroteBy.get(header);
      if (earlier !== undefined && earlier !== entry.id) {
        table.warnCollision(info.routeId, info.slot, header, earlier, entry.id);
      }
      wroteBy.set(header, entry.id);
    }
    current = DefaultExchange.rewrap(current, {
      ...("body" in patch ? { body: patch.body } : {}),
      ...(patch.headers !== undefined
        ? { headers: { ...current.headers, ...patch.headers } }
        : {}),
    });
  }
  return current;
}

const HOOKS_ADAPTER: Adapter = { adapterId: "routecraft.hooks" };

/**
 * A synthetic step that runs one slot's hooks for a route. Absent when no
 * hook applies, so a route nobody hooks pays nothing.
 *
 * @internal
 */
export function buildSlotStep(
  table: HookTable,
  slot: ExchangeSlot,
  routeId: string,
  tags: readonly string[],
): Step<Adapter> | undefined {
  const hooks = table.forRoute(slot, routeId, tags);
  if (hooks.length === 0) return undefined;
  return {
    operation: OperationType.HOOKS,
    label: slot,
    adapter: HOOKS_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const next = await runExchangeHooks(table, hooks, exchange, {
        routeId,
        tags,
        slot,
        kind: "normal",
      });
      return { kind: "continue", exchange: next };
    },
  };
}
