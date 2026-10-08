import { rcError } from "../error.ts";
import type { Port, PortLookup } from "../kernel/port.ts";
import {
  CACHE,
  ENFORCEMENT,
  RESILIENCE,
  type Position,
} from "../kernel/positions.ts";
import type { RouteDefinition } from "../route.ts";
import type { Adapter, Step } from "../types.ts";

/**
 * A route's positions, filled by the providers installed in its application.
 *
 * Built once per route, because a breaker's window and a bulkhead's slots
 * belong to the route. A position the definition does not configure is
 * absent here; whether a given run executes a configured one is the chain
 * policy's call, read from the run's own definition.
 *
 * @internal
 */
export interface CompiledPositions {
  readonly authorize: readonly Step<Adapter>[];
  readonly throttle: readonly Step<Adapter>[];
  readonly circuitBreaker?: Position;
  readonly retry?: Position;
  readonly timeout?: Position;
  /** Outermost first, in declaration order. */
  readonly concurrency: readonly Position[];
  readonly cacheCheck?: Step<Adapter>;
  readonly cacheStore?: Step<Adapter>;
}

type PositionFields = Pick<
  RouteDefinition,
  | "id"
  | "authorize"
  | "throttle"
  | "circuitBreaker"
  | "retry"
  | "timeout"
  | "concurrency"
  | "cache"
>;

/**
 * Fill a route's configured positions from the providers its application
 * installed.
 *
 * @throws RC1111 when the route configures a position nobody provides
 *
 * @internal
 */
export function compilePositions(
  definition: PositionFields,
  context: PortLookup,
): CompiledPositions {
  const provider = <T>(target: Port<T>, method: string): T => {
    const found = context.lookup(target);
    if (found === undefined) {
      throw rcError("RC1111", undefined, {
        message: `Route "${definition.id}" uses .${method}(), and no installed plugin provides "${target.name}". Install a plugin that provides it, or remove .${method}() from the route.`,
      });
    }
    return found;
  };

  const {
    authorize,
    throttle,
    circuitBreaker,
    retry,
    timeout,
    concurrency,
    cache,
  } = definition;
  return {
    authorize: (authorize ?? []).map((options) =>
      provider(ENFORCEMENT, "authorize").authorize(options),
    ),
    throttle: (throttle ?? []).map((options) =>
      provider(RESILIENCE, "throttle").throttle(options, {
        routeId: definition.id,
        scope: "route",
        stepLabel: "route",
      }),
    ),
    ...(circuitBreaker
      ? {
          circuitBreaker: provider(RESILIENCE, "circuitBreaker").circuitBreaker(
            circuitBreaker,
          ),
        }
      : {}),
    ...(retry ? { retry: provider(RESILIENCE, "retry").retry(retry) } : {}),
    ...(timeout
      ? { timeout: provider(RESILIENCE, "timeout").timeout(timeout) }
      : {}),
    concurrency: (concurrency ?? []).map((options) =>
      provider(RESILIENCE, "concurrency").concurrency(options),
    ),
    ...(cache
      ? {
          cacheCheck: provider(CACHE, "cache").check(cache),
          cacheStore: provider(CACHE, "cache").store(cache),
        }
      : {}),
  };
}
