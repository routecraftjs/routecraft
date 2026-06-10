import {
  type Exchange,
  HeadersKeys,
  OperationType,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  markDropped,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import {
  type OnParseError,
  PARSE_DROPPED_REASON,
} from "../adapters/shared/parse.ts";
import { type Adapter, type Step } from "../types.ts";

/**
 * Synthetic pipeline steps the engine inserts around user steps: the
 * source-parse step and the route-scope cache check/store pair. Moved
 * verbatim from route.ts; these have zero coupling to DefaultRoute and
 * communicate only through the exchange and the step queue.
 */

/**
 * Synthetic adapter used as the carrier for the parse step. Has no behaviour;
 * the step's `execute` does the work.
 */
const PARSE_STEP_ADAPTER: Adapter = { adapterId: "routecraft.parse" };

/**
 * Build a synthetic pipeline step that runs a source-supplied parse function
 * against the exchange body. Inserted by `runPipeline` as the first step when a
 * source attaches `parse` to its message; this is what makes parse failures
 * observable as normal pipeline events (rather than aborting the source).
 * See #187.
 *
 * Behaviour on parse failure depends on `failureMode`:
 * - `"fail"` / `"abort"`: throw `RC5016` so `exchange:failed` fires (or the
 *   route's `.error()` handler recovers). The adapter's caller distinguishes
 *   `"abort"` by re-throwing the rejection out of subscribe.
 * - `"drop"`: emit `exchange:dropped` with `reason: "parse-failed"` (matching
 *   filter / validate drop semantics) and halt the pipeline cleanly without
 *   invoking `.error()`.
 *
 * When `applyValidation` is supplied, it runs immediately after a successful
 * parse so route-level `.input()` schemas validate the parsed body, not the
 * raw bytes. Validation failure throws out of `applyValidation` and is
 * handled by the step loop's catch path like any step error.
 *
 * The step manages its own `step:started` / `step:completed` / `step:failed`
 * lifecycle events (`skipStepEvents: true`) so we can emit `step:completed`
 * for the drop case (drops are not failures) without the route loop
 * double-emitting.
 */
export function buildParseStep(
  parse: (raw: unknown) => unknown | Promise<unknown>,
  failureMode: OnParseError,
  applyValidation?: (exchange: Exchange) => Promise<Exchange>,
): Step<Adapter> {
  return {
    operation: OperationType.PARSE,
    label: "parse",
    adapter: PARSE_STEP_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const internals = EXCHANGE_INTERNALS.get(exchange);
      const context = internals?.context;
      const route = internals?.route;
      const routeId =
        route?.definition.id ??
        (exchange.headers[HeadersKeys.ROUTE_ID] as string);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const stepStart = Date.now();

      const emitStepStarted = () => {
        context?.emit("route:step:started", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
        });
      };
      const emitStepCompleted = () => {
        context?.emit("route:step:completed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
          duration: Date.now() - stepStart,
        });
      };
      const emitStepFailed = (err: unknown) => {
        context?.emit("route:step:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
          duration: Date.now() - stepStart,
          error: err instanceof Error ? err.message : String(err),
        });
      };

      emitStepStarted();

      let parsed: Exchange;
      try {
        const parsedBody = await parse(exchange.body);
        parsed = DefaultExchange.rewrap(exchange, { body: parsedBody });
      } catch (cause) {
        if (failureMode === "drop") {
          // The parse threw, so the step itself failed: emit step:failed
          // (honest about what happened), then exchange:dropped with a
          // stable reason (carries the policy decision). Subscribers
          // counting parse failures see step:failed; subscribers
          // tracking drop policy see exchange:dropped.
          emitStepFailed(cause);
          // Mark dropped before `exchange:dropped` fires so subscribers
          // calling `isDropped(event.details.exchange)` observe the
          // correct state. The route engine reads it after `runPipeline`
          // to skip `exchange:completed`.
          markDropped(exchange);
          context?.emit("route:exchange:dropped", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            reason: PARSE_DROPPED_REASON,
            exchange,
          });
          return { kind: "drop" } as const;
        }
        // 'fail' / 'abort': throw RC5016 so the step loop's catch path
        // emits exchange:failed (or invokes the route's `.error()`).
        emitStepFailed(cause);
        const causeMessage =
          cause instanceof Error ? cause.message : String(cause);
        throw rcError("RC5016", cause, {
          message: `Source payload parse failed: ${causeMessage}`,
        });
      }

      if (applyValidation) {
        try {
          parsed = await applyValidation(parsed);
        } catch (cause) {
          emitStepFailed(cause);
          throw cause;
        }
      }

      emitStepCompleted();
      // Hand control back to the executor with the parsed exchange.
      return { kind: "continue", exchange: parsed } as const;
    },
  };
}

/**
 * Synthetic adapter carriers for the route-scope cache filter steps.
 * Distinct adapter ids per filter so telemetry / event subscribers
 * correlating by `adapter` can tell read failures (`cache.check`) from
 * write failures (`cache.store`) without parsing the step label.
 * Neither carrier has behaviour; the steps' `execute` does the work.
 */
const CACHE_CHECK_STEP_ADAPTER: Adapter = {
  adapterId: "routecraft.cache.check",
};
const CACHE_STORE_STEP_ADAPTER: Adapter = {
  adapterId: "routecraft.cache.store",
};

/**
 * Build the route-scope cache HIT-CHECK synthetic step. Inserted into
 * `initialSteps` AFTER `buildParseStep` (so parse + `applyValidation`
 * have already run) and BEFORE the user steps. Derives the cache key
 * from the parsed/validated exchange, looks it up in the provider, and
 * on a hit pushes a rewrapped exchange with `steps: []` to short-circuit
 * the rest of the pipeline (including the matching cache-store step).
 * On a miss pushes the exchange with the unchanged `remainingSteps` so
 * the user pipeline runs.
 *
 * Manages its own observability: emits `cache:hit` / `cache:miss` /
 * `cache:failed` plus `exchange:restored` on a hit. `skipStepEvents:
 * true` keeps `runPipeline` from emitting generic `step:started` /
 * `step:completed` for this internal step.
 *
 * @internal Exported only so `RouteBuilder.from()` can assemble it into
 * `RouteDefinition.postParseFilters`. Not part of the public API; the
 * signature may change without notice.
 */
export function buildCacheCheckStep(
  cacheConfig: import("../operations/cache-wrapper.ts").ResolvedCacheOptions,
): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    label: "cache-check",
    adapter: CACHE_CHECK_STEP_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const internals = EXCHANGE_INTERNALS.get(exchange);
      const context = internals?.context;
      const route = internals?.route;
      const routeId =
        route?.definition.id ??
        (exchange.headers[HeadersKeys.ROUTE_ID] as string);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;

      let key: string;
      try {
        key = cacheConfig.key(exchange);
      } catch (err) {
        context?.emit("route:cache:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel: "route",
          scope: "route",
          phase: "key",
          error: err instanceof Error ? err.message : String(err),
        });
        throw isRoutecraftError(err)
          ? err
          : rcError("RC5029", err, {
              message: `Route-scope .cache({ key }) for "${routeId}" threw while deriving the cache key`,
            });
      }
      // Hand the key off to the matching cache-store filter via
      // exchange internals. Internals is the framework's per-exchange
      // state bag set at construction time; absence here means the
      // caller built an exchange outside `DefaultExchange.rewrap`,
      // which violates the contract. Fail loudly rather than silently
      // skip the cache write at the tail of the pipeline.
      if (!internals) {
        throw rcError("RC5028", undefined, {
          message: `Route-scope .cache() for "${routeId}" ran on an exchange without framework internals; cache key cannot be propagated to the store step. This indicates an adapter or step constructed an Exchange outside DefaultExchange.rewrap.`,
        });
      }
      internals.cacheKey = key;

      let cached: unknown;
      try {
        cached = await cacheConfig.provider.get(key);
      } catch (err) {
        context?.emit("route:cache:failed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel: "route",
          scope: "route",
          phase: "get",
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        throw isRoutecraftError(err)
          ? err
          : rcError("RC5028", err, {
              message: `Route-scope .cache() provider read failed for "${routeId}"`,
            });
      }

      if (cached !== undefined) {
        // HIT: short-circuit the pipeline by pushing the rewrapped
        // exchange with no remaining steps. The matching cache-store
        // step (tail of initialSteps) is therefore skipped too.
        context?.emit("route:cache:hit", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          stepLabel: "route",
          scope: "route",
          key,
        });
        context?.emit("route:exchange:restored", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          source: "cache",
        });
        // Complete: skip the rest of the pipeline (including the matching
        // cache-store step) and finish the exchange with the cached body.
        return {
          kind: "complete",
          exchange: DefaultExchange.rewrap(exchange, { body: cached }),
        } as const;
      }

      // MISS: continue the pipeline.
      context?.emit("route:cache:miss", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel: "route",
        scope: "route",
        key,
      });
      return { kind: "continue", exchange } as const;
    },
  };
}

/**
 * Build the route-scope cache STORE synthetic step. Inserted as the
 * tail of `initialSteps` after the user steps. Reached only on the
 * miss path (the cache-check step pushes `steps: []` on a hit to skip
 * everything including this step). Writes the terminal body using the
 * key captured by the matching check step.
 *
 * Provider write failures emit `cache:failed phase:"set"` for
 * observability but do NOT fail the exchange: the result was already
 * computed by the user pipeline. This diverges from step-scope, where
 * a write failure throws RC5028; the divergence is intentional and
 * documented on the operation reference page.
 *
 * `skipStepEvents: true` keeps `runPipeline` from emitting generic
 * lifecycle events for this internal step.
 *
 * @internal Exported only so `RouteBuilder.from()` can assemble it into
 * `RouteDefinition.postFromFilters`. Not part of the public API; the
 * signature may change without notice.
 */
export function buildCacheStoreStep(
  cacheConfig: import("../operations/cache-wrapper.ts").ResolvedCacheOptions,
): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    label: "cache-store",
    adapter: CACHE_STORE_STEP_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const internals = EXCHANGE_INTERNALS.get(exchange);
      const context = internals?.context;
      const route = internals?.route;
      const routeId =
        route?.definition.id ??
        (exchange.headers[HeadersKeys.ROUTE_ID] as string);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const key = internals?.cacheKey;

      // Only cache successful runs whose terminal body is not
      // `undefined`. `null` is cached (envelope handles it). Dropped
      // exchanges never reach this step because the queue loop stops
      // pushing on a drop.
      if (key !== undefined && exchange.body !== undefined) {
        try {
          await cacheConfig.provider.set(key, exchange.body, cacheConfig.ttl);
          context?.emit("route:cache:stored", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            stepLabel: "route",
            scope: "route",
            key,
            ...(cacheConfig.ttl !== undefined ? { ttl: cacheConfig.ttl } : {}),
          });
        } catch (err) {
          context?.emit("route:cache:failed", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            stepLabel: "route",
            scope: "route",
            phase: "set",
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { kind: "continue", exchange } as const;
    },
  };
}
