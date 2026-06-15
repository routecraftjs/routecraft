import { LRUCache } from "lru-cache";
import {
  type Adapter,
  type Step,
  type StepOutcome,
  forRoute,
} from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  emitExchangeDropped,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import type { CraftContext } from "../context.ts";
import type { Route } from "../route.ts";
import { hashExchangeBody } from "./hash-body.ts";
import { DEFAULT_MAX_KEYS, validateMaxKeys } from "./max-keys.ts";

/**
 * Options for the `.dedupe()` flow-control operation.
 */
export interface DedupeOptions {
  /**
   * Derive the deduplication key from the exchange. The returned string is
   * the identity two exchanges are compared on. When omitted, a key is
   * computed by SHA-256 hashing `JSON.stringify(body)` (see
   * {@link hashExchangeBody}); supply an explicit `key` when the body is not
   * JSON-serialisable or when a stable identity lives in a header (a file
   * path, an event id) that should survive body changes.
   */
  key?: (exchange: Exchange) => string;
  /**
   * Time to live in milliseconds for a committed key. After expiry, the
   * next exchange with that key is treated as new (passes again). When
   * omitted, committed keys are retained until LRU eviction at `maxKeys`.
   *
   * This is the memory bound for long-running routes: without a `ttl`, only
   * `maxKeys` caps the committed set, and an evicted key's next occurrence
   * is no longer recognised as a duplicate.
   */
  ttl?: number;
  /**
   * Maximum number of committed keys retained per route. The committed set
   * is an LRU, so memory stays bounded even with an unbounded key space (the
   * least-recently-committed key is evicted, and its next occurrence passes
   * as new). Default `10_000`.
   */
  maxKeys?: number;
}

/**
 * {@link DedupeOptions} with every field resolved and validated.
 *
 * @internal
 */
export interface ResolvedDedupeOptions {
  key: (exchange: Exchange) => string;
  ttl: number | undefined;
  maxKeys: number;
}

/**
 * Validate user-supplied {@link DedupeOptions} into a
 * {@link ResolvedDedupeOptions}, filling defaults: the SHA-256 body hasher
 * for `key`, no TTL, and a `maxKeys` ceiling of 10_000. Rejects at build
 * time (RC5003) so a typo fails when the route is built.
 *
 * @internal
 */
export function resolveDedupeOptions(
  options: DedupeOptions = {},
): ResolvedDedupeOptions {
  const { ttl, maxKeys = DEFAULT_MAX_KEYS } = options;

  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
    throw rcError("RC5003", undefined, {
      message: `dedupe({ ttl }) must be a finite number > 0 (milliseconds), got ${String(ttl)}.`,
    });
  }
  // Upper-bound `maxKeys`: the committed-key LRU pre-allocates index arrays
  // sized to `max` at construction, so an "effectively unlimited" value
  // would OOM the process the moment the dedupe state is built.
  validateMaxKeys("dedupe", maxKeys);

  return {
    key: options.key ?? defaultDedupeKey,
    ttl,
    maxKeys,
  };
}

function defaultDedupeKey(exchange: Exchange<unknown>): string {
  try {
    return hashExchangeBody(exchange.body);
  } catch (err) {
    throw rcError("RC5033", err, {
      message:
        "Default dedupe key derivation failed: the exchange body is not JSON-serialisable. " +
        "Supply an explicit `key` function in dedupe({ key: ... }).",
    });
  }
}

/**
 * Per-route dedupe state implementing the reserve / commit / release
 * protocol. A key is reserved the moment an exchange enters dedupe and
 * stays reserved until that exchange reaches a terminal route event:
 *
 * - `route:exchange:completed` -> commit (the input was handled cleanly,
 *   so future occurrences are duplicates).
 * - `route:exchange:dropped` / `route:exchange:failed` -> release (the input
 *   was not successfully handled, so a re-send may try again).
 *
 * A key that is reserved OR committed is a duplicate. Reservation gives
 * single-flight behaviour: a second exchange with the same key that arrives
 * while the first is still in flight is dropped without waiting. One
 * instance per Route (see {@link DedupeController}), never one per exchange.
 *
 * @internal
 */
class DedupeState {
  /** Committed keys, LRU- and (optionally) TTL-bounded. */
  readonly #committed: LRUCache<string, true>;
  /** Keys reserved by an in-flight exchange (single-flight gate). */
  readonly #reserved = new Set<string>();
  /** Maps a reserving exchange's id to the key it holds, for commit/release. */
  readonly #pending = new Map<string, string>();
  #subscribed = false;

  constructor(options: ResolvedDedupeOptions) {
    this.#committed = new LRUCache<string, true>({
      max: options.maxKeys,
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
      // Duplicate detection reads via `has()`; refresh recency (and TTL) on
      // a hit so a frequently-seen key is not LRU-evicted ahead of colder
      // keys and a sliding TTL keeps suppressing an actively-arriving
      // duplicate stream.
      updateAgeOnHas: true,
    });
  }

  /** A key already reserved by an in-flight exchange or committed is a duplicate. */
  isDuplicate(key: string): boolean {
    return this.#reserved.has(key) || this.#committed.has(key);
  }

  /** Reserve `key` for `exchangeId` (single-flight gate). */
  reserve(key: string, exchangeId: string): void {
    this.#reserved.add(key);
    this.#pending.set(exchangeId, key);
  }

  /** Terminal success: promote the reservation to a committed key. */
  commit(exchangeId: string): void {
    const key = this.#pending.get(exchangeId);
    if (key === undefined) return;
    this.#pending.delete(exchangeId);
    this.#reserved.delete(key);
    this.#committed.set(key, true);
  }

  /**
   * Terminal failure or drop: drop the reservation without committing, so a
   * re-send may try again. A drop is treated like a failure here on purpose:
   * an exchange that dedupe let through but a later step discarded (a filter
   * rejection, a halt) was not actually handled, so committing its key would
   * permanently suppress a legitimate re-send. Only a clean completion
   * commits.
   */
  release(exchangeId: string): void {
    const key = this.#pending.get(exchangeId);
    if (key === undefined) return;
    this.#pending.delete(exchangeId);
    this.#reserved.delete(key);
  }

  /**
   * Subscribe the commit / release hooks to the route's terminal exchange
   * events exactly once. The reservation pattern needs to know when an
   * exchange finished the whole pipeline, which the exchange-lifecycle
   * events report; `forRoute` scopes them to this route. A clean completion
   * commits; a failure or a drop releases. Subscriptions are torn down when
   * the route aborts (and the state is re-armed) so they do not accumulate
   * across route restarts on a shared context.
   */
  ensureSubscribed(
    context: CraftContext,
    routeId: string,
    route: Route | undefined,
  ): void {
    if (this.#subscribed) return;
    this.#subscribed = true;

    const offs = [
      context.on(
        "route:exchange:completed",
        forRoute(routeId, ({ details }) => this.commit(details.exchangeId)),
      ),
      context.on(
        "route:exchange:dropped",
        forRoute(routeId, ({ details }) => this.release(details.exchangeId)),
      ),
      context.on(
        "route:exchange:failed",
        forRoute(routeId, ({ details }) => this.release(details.exchangeId)),
      ),
    ];

    if (route) {
      const cleanup = (): void => {
        for (const off of offs) off();
        // Re-arm: a fresh run of this route (after a restart on a shared
        // context) re-subscribes rather than running with dead listeners.
        this.#subscribed = false;
        this.#reserved.clear();
        this.#pending.clear();
      };
      if (route.signal.aborted) cleanup();
      else route.signal.addEventListener("abort", cleanup, { once: true });
    }
  }
}

/**
 * Owns the dedupe state for one `.dedupe()` across every Route the step
 * runs in. Keyed by Route in a WeakMap, so a single step instance shared by
 * a `RouteDefinition` registered into multiple contexts gives each Route its
 * OWN seen-key set rather than one shared set (which would let the contexts
 * suppress each other's exchanges). Mirrors `ThrottleController`.
 *
 * @internal
 */
class DedupeController {
  readonly #options: ResolvedDedupeOptions;
  readonly #byRoute = new WeakMap<Route, DedupeState>();
  #routeless?: DedupeState;

  constructor(options: ResolvedDedupeOptions) {
    this.#options = options;
  }

  stateFor(route: Route | undefined): DedupeState {
    if (!route) {
      this.#routeless ??= new DedupeState(this.#options);
      return this.#routeless;
    }
    let state = this.#byRoute.get(route);
    if (!state) {
      state = new DedupeState(this.#options);
      this.#byRoute.set(route, state);
    }
    return state;
  }
}

/** Marker adapter for the dedupe step; carries no configuration. */
export interface DedupeAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.dedupe";
}

/**
 * Step that suppresses duplicate exchanges by a derived key. The first time
 * a key is seen it is reserved and the exchange continues; a subsequent
 * exchange whose key is still reserved (in flight) or already committed
 * (handled) is dropped silently, exactly like a `filter` returning false.
 *
 * Reservation semantics give single-flight behaviour and correct retries:
 * the key is committed only when the exchange completes the route cleanly
 * (`route:exchange:completed`) and released when it fails or is dropped
 * (`route:exchange:failed` / `:dropped`), so an input that was not actually
 * handled is not permanently suppressed. State is in-memory and per-route
 * (see {@link DedupeController}); a cross-instance provider is a future
 * addition.
 *
 * Emits `route:operation:dedupe:pass` when a key is reserved and
 * `route:operation:dedupe:duplicate` (plus `route:exchange:dropped`, reason
 * `"duplicate"`) when one is suppressed.
 *
 * Known limitation: the commit/release decision is keyed on the entering
 * exchange's terminal event, so placing `.dedupe()` before a `split` (or
 * other fan-out) whose children fail still commits the parent's key (the
 * parent completes even when children fail), suppressing a retriable
 * re-send. Place `.dedupe()` after a fan-out until lineage-aware settlement
 * lands (tracked as a follow-up).
 */
export class DedupeStep implements Step<DedupeAdapter> {
  operation: OperationType = OperationType.DEDUPE;
  label?: string;
  adapter: DedupeAdapter = { adapterId: "routecraft.operation.dedupe" };
  skipStepEvents = true;

  readonly #options: ResolvedDedupeOptions;
  readonly #controller: DedupeController;

  constructor(options: DedupeOptions = {}) {
    this.#options = resolveDedupeOptions(options);
    this.#controller = new DedupeController(this.#options);
  }

  async execute(exchange: Exchange): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const stepLabel = this.label ?? this.operation;
    const stepStart = Date.now();

    if (context) {
      context.emit("route:step:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
      });
    }

    let key: string;
    try {
      key = this.#options.key(exchange);
    } catch (err) {
      if (context) {
        context.emit("route:step:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          duration: Date.now() - stepStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Surface a coded error for a throwing user `key`, mirroring the
      // default-key path (RC5033) and cache's RC5029, rather than leaking a
      // bare throw. The default-key deriver already throws RC5033.
      throw isRoutecraftError(err)
        ? err
        : rcError("RC5033", err, {
            message: `dedupe({ key }) for "${stepLabel}" threw while deriving the key`,
          });
    }

    const state = this.#controller.stateFor(route);
    // Wire commit/release to the route's terminal events the first time we
    // run; safe to call on every exchange (it no-ops after the first).
    if (route && context) state.ensureSubscribed(context, routeId, route);

    // Reserve only when bound to a route: the reservation is released by a
    // terminal exchange event scoped to the route (and torn down on the
    // route's abort signal), neither of which exists on the route-less
    // synthetic/unit path, where reserving would leak the key and the
    // listeners forever. Without a route dedupe degrades to pass-through.
    const duplicate = state.isDuplicate(key);
    if (!duplicate && route && context) state.reserve(key, exchange.id);

    if (context) {
      context.emit("route:step:completed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        duration: Date.now() - stepStart,
      });
    }

    if (duplicate) {
      context?.emit("route:operation:dedupe:duplicate", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        key,
      });
      emitExchangeDropped(context, {
        routeId,
        correlationId,
        reason: "duplicate",
        exchange,
      });
      return { kind: "drop" };
    }

    context?.emit("route:operation:dedupe:pass", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      key,
    });
    return { kind: "continue", exchange };
  }
}
