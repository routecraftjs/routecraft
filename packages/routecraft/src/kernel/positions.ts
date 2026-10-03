import type { Exchange } from "../exchange.ts";
import type { ForwardFn } from "../route.ts";
import type {
  Adapter,
  EventDetailsMap,
  EventName,
  Step,
  StepOutcome,
} from "../types.ts";
import type { ResolvedRetryOptions } from "../operations/retry-wrapper.ts";
import type { ResolvedTimeoutOptions } from "../operations/timeout-wrapper.ts";
import type { ResolvedThrottleOptions } from "../operations/throttle-wrapper.ts";
import type { ResolvedCircuitBreakerOptions } from "../operations/circuit-breaker-wrapper.ts";
import type { ResolvedConcurrencyOptions } from "../operations/concurrency-wrapper.ts";
import type { ResolvedCacheOptions } from "../operations/cache-wrapper.ts";
import type { AuthorizeOptions } from "../auth/authorize.ts";
import { port } from "./port.ts";

/**
 * An opaque identity for one route in one application, for a position that
 * keeps per-route state (a breaker's window, a bulkhead's slots).
 */
export type RouteKey = object;

/**
 * One run of a position: what the kernel hands the provider each time an
 * exchange reaches it.
 */
export interface PositionRun {
  readonly routeId: string;
  /** Stable per route; key per-route state by it. */
  readonly route: RouteKey;
  readonly exchange: Exchange;
  /**
   * Fires when the route stops taking intake or an outer position abandons
   * this attempt. A position that waits (a backoff, a queue) stops waiting.
   */
  readonly signal: AbortSignal;
  /** Fires only when an outer position abandoned this attempt. */
  readonly abandon?: AbortSignal;
  /**
   * The run is a continuation that may not be refused below the claim: a
   * position that could refuse (a bulkhead) queues instead.
   */
  readonly mustWait: boolean;
  /**
   * Run everything inside this position once. A failure rejects, so the
   * position can react; the outcome is what the next position out sees.
   *
   * @param signal - Abandons this attempt when it fires
   */
  attempt(signal?: AbortSignal): Promise<StepOutcome>;
  /** Send to a direct endpoint carrying this exchange's principal. */
  readonly forward: ForwardFn;
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
}

/** A position that surrounds what follows it: retry, timeout, a breaker, a bulkhead. */
export interface Position {
  run(run: PositionRun): Promise<StepOutcome>;
}

/**
 * What the `RESILIENCE` port provides: the five resilience positions of the
 * chain. Built once per route when the route first runs.
 */
export interface ResiliencePositions {
  /** An admission gate, run once per exchange outside the attempts. */
  throttle(options: ResolvedThrottleOptions, routeId: string): Step<Adapter>;
  circuitBreaker(options: ResolvedCircuitBreakerOptions): Position;
  retry(options: ResolvedRetryOptions): Position;
  timeout(options: ResolvedTimeoutOptions): Position;
  concurrency(options: ResolvedConcurrencyOptions): Position;
}

/** What the `CACHE` port provides: the two cache positions. */
export interface CachePositions {
  check(options: ResolvedCacheOptions): Step<Adapter>;
  store(options: ResolvedCacheOptions): Step<Adapter>;
}

/** What the `ENFORCEMENT` port provides: the authorize position. */
export interface EnforcementPositions {
  /** One gate per `.authorize()` call; they AND together in order. */
  authorize(options: AuthorizeOptions): Step<Adapter>;
}

/** The resilience positions: throttle, circuitBreaker, retry, timeout, concurrency. */
export const RESILIENCE = port<ResiliencePositions>("routecraft.resilience@1");

/** The cache positions: cacheCheck and cacheStore. */
export const CACHE = port<CachePositions>("routecraft.cache@1");

/** The authorize position. */
export const ENFORCEMENT = port<EnforcementPositions>(
  "routecraft.enforcement@1",
);
