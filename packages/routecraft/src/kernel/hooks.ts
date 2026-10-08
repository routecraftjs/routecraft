import { engineOwnedHeaderSuggestion } from "../engine-headers.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
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

/**
 * What a validate hook's refusal means to the caller, in a vocabulary no
 * transport owns. Each door renders it in its own protocol: the http doors as
 * a status (`invalid` 400, `unauthenticated` 401, `forbidden` 403,
 * `not_found` 404, `conflict` 409, `gone` 410, `rate_limited` 429,
 * `unavailable` 503), the MCP server as a tool error naming it.
 */
export const REFUSAL_KINDS = [
  "invalid",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "gone",
  "rate_limited",
  "unavailable",
] as const;

/** How a door answers a refusal; one of {@link REFUSAL_KINDS}. */
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

/** A validate hook's refusal, built with {@link refuse}. */
export interface Refusal {
  readonly [REFUSAL]: true;
  readonly reason: string;
  readonly kind: RefusalKind;
}

const REFUSALS = new WeakSet<object>();

/**
 * Refuse the exchange from a `validate` hook. The run fails with `RC5068`
 * naming the hook and the reason, and the failure reaches the `error` slot
 * like any other. A door that dispatched the route answers the caller with
 * the kind and the reason, so write the reason for the refused party, never
 * with anything the instance owns.
 *
 * @param reason - Why, in words the caller reads
 * @param options - `kind`: how a door answers it; `forbidden` unless given
 * @returns The refusal to return from the hook
 */
export function refuse(
  reason: string,
  options: { readonly kind?: RefusalKind } = {},
): Refusal {
  const refusal = { reason, kind: options.kind ?? "forbidden" } as Refusal;
  REFUSALS.add(refusal);
  return Object.freeze(refusal);
}

/**
 * Machine-readable detail on the cause of an `RC5068`: which hook refused,
 * where, on which route, and how a door should answer. A door reads it off
 * `error.cause` through {@link isHookRefusal} and maps the refusal only when
 * the route is the one it dispatched, so a refusal raised by a nested
 * `direct()` call stays the instance's. In-process only, never persisted.
 */
export interface HookRefusal extends Error {
  readonly refused: {
    /** The hook, as `pluginId/hookId`. */
    readonly hook: string;
    /** The slot or point the hook ran in. */
    readonly slot: string;
    readonly routeId: string;
    readonly kind: RefusalKind;
    readonly reason: string;
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(REFUSAL_KINDS);

/**
 * The refusal details this module raised. Membership cannot be read back or
 * copied onto another object, so a step throwing an `RC5068` with a
 * hand-built detail cannot dress its own failure up as the caller's.
 */
const RAISED = new WeakSet<object>();

/**
 * Whether `value` (an `RC5068` error's `cause`) carries the
 * {@link HookRefusal} detail.
 *
 * @param value - Any value, usually `error.cause`
 * @returns `true` when the value is an Error carrying a well-formed `refused` detail
 */
export function isHookRefusal(value: unknown): value is HookRefusal {
  if (!(value instanceof Error)) return false;
  const refused = (value as { refused?: unknown }).refused;
  if (typeof refused !== "object" || refused === null) return false;
  const fields = refused as Record<string, unknown>;
  return (
    typeof fields["hook"] === "string" &&
    typeof fields["slot"] === "string" &&
    typeof fields["routeId"] === "string" &&
    typeof fields["reason"] === "string" &&
    KNOWN_KINDS.has(fields["kind"] as string)
  );
}

/**
 * Whether `value` is a {@link HookRefusal} detail the kernel raised for a
 * validate hook, as opposed to the same shape built by a step. What a door
 * maps to the caller; {@link isHookRefusal} reads the detail off any error.
 *
 * @internal
 */
export function isRaisedHookRefusal(value: unknown): value is HookRefusal {
  return isHookRefusal(value) && RAISED.has(value);
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
   * `pluginId/id`. Required, and stable across the plugin's releases: an
   * application that disables or reorders a hook names it, so a name that
   * followed the function's name or its position would move under that
   * config on a bundle or a patch release.
   */
  readonly id: string;
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
 * answer decides. Any other value is the recovery body, a logger's return
 * included, so a mutate hook that means to pass returns nothing.
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
  /**
   * What a resume payload must satisfy when this hook parks the exchange
   * with `recovery.defer()`. Declared on the hook so the resume door reads
   * it live and validates against it (`RC5049`); a changed or removed
   * schema refuses the resume (`RC5048`).
   */
  readonly schema?: StandardSchemaV1;
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
  /**
   * Hooks at points other plugins declare, by point name. Kept apart from
   * the slots so a misspelled slot is a compile error rather than a point
   * nobody declared.
   */
  readonly points?: Readonly<Record<string, OneOrMany<ExchangeHook>>>;
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

/**
 * One hook as it applies to one route, for whoever reads the route from
 * outside: the ops route detail, a plugin listing what runs on a route.
 * Names the plugin and the hook, never the hook's code.
 */
export interface RouteHookView {
  /** The slot, or the point when `point` is true. */
  readonly slot: string;
  /** True for a point a plugin declared rather than a slot of the chain. */
  readonly point: boolean;
  /** Absent for a `perAttempt` wrapper, which has no phase. */
  readonly phase?: Phase;
  readonly plugin: string;
  /** `pluginId/hookId`, the name `hooks.order` and `hooks.disable` address. */
  readonly id: string;
}

const PHASE_ORDER: readonly Phase[] = ["observe", "mutate", "validate"];

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
  private readonly declaredConflicts = new Set<string>();
  /** The table is complete once constructed, so a route's selection is too. */
  private readonly selections = new Map<string, InstalledHook[]>();

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
      const { points: atPoints, ...slots } = plugin.hooks ?? {};
      for (const [point] of Object.entries(atPoints ?? {})) {
        if (!this.points.has(point)) {
          throw rcError("RC1112", undefined, {
            message: `Plugin "${plugin.id}" declares a hook at the point "${point}", which no installed plugin declares.`,
          });
        }
      }
      for (const [slot, declared] of [
        ...Object.entries(slots),
        ...Object.entries(atPoints ?? {}),
      ]) {
        if (!SLOTS.includes(slot as Slot) && !this.points.has(slot)) {
          throw rcError("RC1112", undefined, {
            message: `Plugin "${plugin.id}" declares a hook in "${slot}", which is not a slot of the chain (${SLOTS.join(", ")}). A hook at a point goes under hooks.points.`,
          });
        }
        for (const hook of asList(declared)) {
          const h = hook as ExchangeHook & WrapperHook & ErrorHook;
          this.checkShape(plugin.id, slot, h);
          const id = `${plugin.id}/${h.id}`;
          const list = this.bySlot.get(slot) ?? [];
          if (list.some((existing) => existing.id === id)) {
            throw rcError("RC1112", undefined, {
              message: `Plugin "${plugin.id}" declares two hooks named "${id}" in "${slot}". Give one an explicit id.`,
            });
          }
          list.push({ pluginId: plugin.id, id, slot, hook: h });
          this.bySlot.set(slot, list);
        }
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
    if (typeof hook.id !== "string" || hook.id.length === 0) {
      throw rcError("RC1117", undefined, {
        message: `${where} has no id. Every hook names itself, so hooks.order and hooks.disable can address it as "${pluginId}/<id>".`,
      });
    }
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
    for (const slot of this.bySlot.keys()) {
      const writers = new Map<string, string>();
      for (const entry of this.ordered(slot, "mutate")) {
        for (const header of (entry.hook as MutateHook).writes ?? []) {
          const earlier = writers.get(header);
          if (earlier !== undefined) {
            this.declaredConflicts.add(
              `${slot}\0${header}\0${earlier}\0${entry.id}`,
            );
            this.logger.warn(
              { slot, header, earlier, later: entry.id },
              `${slot}/mutate: ${earlier} and ${entry.id} both write ${header}; ${entry.id} wins (it runs later). Settle it with hooks.order or hooks.disable.`,
            );
          }
          writers.set(header, entry.id);
        }
      }
    }
  }

  /** Whether a point of this name was declared. */
  hasPoint(name: string): boolean {
    return this.points.has(name);
  }

  /**
   * Every hook that applies to a route, in the order it runs: slot by slot
   * in chain order and phase by phase within a slot, then the declared
   * points in declaration order.
   */
  describeRoute(
    routeId: string,
    tags: readonly string[],
  ): readonly RouteHookView[] {
    const places = [
      ...SLOTS.map((slot) => ({ slot, point: false })),
      ...[...this.points.keys()].map((slot) => ({ slot, point: true })),
    ];
    return places.flatMap(({ slot, point }) =>
      this.forRoute(slot, routeId, tags).map((entry) => {
        const phase = (entry.hook as { phase?: Phase }).phase;
        return {
          slot,
          point,
          ...(phase !== undefined ? { phase } : {}),
          plugin: entry.pluginId,
          id: entry.id,
        };
      }),
    );
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
  ): readonly InstalledHook[] {
    const key = `${slot}\u0000${routeId}\u0000${tags.join("\u0000")}`;
    const cached = this.selections.get(key);
    if (cached !== undefined) return cached;
    const phases = slot === "perAttempt" ? [undefined] : PHASE_ORDER;
    const selected = phases.flatMap((phase) =>
      this.ordered(slot, phase).filter((entry) =>
        appliesTo(entry.hook as HookBase, routeId, tags),
      ),
    );
    this.selections.set(key, selected);
    return selected;
  }

  /**
   * The `error` slot hooks that apply to one route: the `observe` ones,
   * which hear the failure, and the `mutate` ones, which may decide it, each
   * in effective order.
   */
  errorHooks(
    routeId: string,
    tags: readonly string[],
  ): {
    observe: readonly InstalledHook[];
    decide: readonly InstalledHook[];
  } {
    const all = this.forRoute("error", routeId, tags);
    return {
      observe: all.filter((e) => (e.hook as ErrorHook).phase === "observe"),
      decide: all.filter((e) => (e.hook as ErrorHook).phase === "mutate"),
    };
  }

  /**
   * Whether any live `error` slot hook declared it may park an exchange.
   * Such a hook can defer ANY route it applies to, so the answer is read
   * per application rather than per route.
   */
  mayDefer(): boolean {
    return this.ordered("error").some(
      (entry) => (entry.hook as ErrorHook).mayDefer === true,
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
    // Declared up front, so already said once at build.
    if (
      this.declaredConflicts.has(`${slot}\0${header}\0${earlier}\0${later}`)
    ) {
      return;
    }
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

const EVERY_RUN: readonly RunKind[] = [
  "normal",
  "resume",
  "debounce",
  "errorChannel",
];

/**
 * The tags a route's hooks are selected by: its discovery tags. Every
 * selection site reads them here, so a hook can never apply in one slot of
 * a route and miss another.
 *
 * @internal
 */
export function routeTags(definition: {
  readonly discovery?: { readonly tags?: readonly string[] };
}): readonly string[] {
  return definition.discovery?.tags ?? [];
}

/**
 * Whether a hook applies to a kind of run. A hook that declares no `runs`
 * applies to normal runs only, except in the `error` slot, which hears every
 * failure that escapes the chain on any run and tells its hooks which one
 * through `info.execution`.
 */
export function runsOn(
  hook: { runs?: readonly RunKind[] },
  kind: RunKind,
  slot?: string,
): boolean {
  return (hook.runs ?? (slot === "error" ? EVERY_RUN : ["normal"])).includes(
    kind,
  );
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
        const detail = new Error(result.reason) as Error & {
          refused: HookRefusal["refused"];
        };
        detail.refused = {
          hook: entry.id,
          slot: info.slot,
          routeId: info.routeId,
          kind: result.kind,
          reason: result.reason,
        };
        RAISED.add(detail);
        throw rcError("RC5068", detail, {
          message: `${entry.id} refused the exchange in "${info.slot}" (${result.kind}): ${result.reason}`,
        });
      }
      throw rcError("RC1115", undefined, {
        message: `Validate hook ${entry.id} in "${info.slot}" returned something other than a refusal. A validate hook allows by returning nothing and refuses with refuse(reason); it never changes the exchange.`,
      });
    }
    if (result === undefined) continue;
    const patch = result as ExchangePatch;
    for (const header of Object.keys(patch.headers ?? {})) {
      const owned = engineOwnedHeaderSuggestion(header);
      if (owned !== undefined) {
        throw rcError("RC1115", undefined, {
          message: `Mutate hook ${entry.id} in "${info.slot}" wrote the engine-owned header "${header}". ${owned}`,
        });
      }
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
