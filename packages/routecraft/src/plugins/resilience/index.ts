import { rcError } from "../../error.ts";
import { HeadersKeys } from "../../exchange.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { registerDefaultPlugin } from "../../kernel/defaults.ts";
import {
  RESILIENCE,
  type Position,
  type PositionRun,
  type ResiliencePositions,
} from "../../kernel/positions.ts";
import { anySignal } from "../../shared/abort.ts";
import { buildThrottleCheckStep } from "../../pipeline/synthetic-steps.ts";
import { executeWithRetry } from "../../operations/retry-wrapper.ts";
import {
  DeadlineExceededError,
  raceWithDeadline,
} from "../../operations/timeout-wrapper.ts";
import {
  CircuitBreakerController,
  circuitBreakerEmitHooks,
  circuitOpenOutcome,
  executeWithCircuitBreaker,
  type CircuitBreakerEventScope,
} from "../../operations/circuit-breaker-wrapper.ts";
import {
  ConcurrencyController,
  concurrencyEmitHooks,
  executeWithConcurrency,
  type ConcurrencyEventScope,
} from "../../operations/concurrency-wrapper.ts";

/** The event fields every route-scope resilience event carries. */
function scopeOf(run: PositionRun) {
  return {
    routeId: run.routeId,
    exchangeId: run.exchange.id,
    correlationId: run.exchange.headers[HeadersKeys.CORRELATION_ID] as string,
    stepLabel: "route",
    scope: "route" as const,
  };
}

/**
 * The framework's resilience positions: what fills `throttle`,
 * `circuitBreaker`, `retry`, `timeout` and `concurrency` unless an installed
 * plugin replaces {@link RESILIENCE}.
 */
export const resilienceProvider: ResiliencePositions = {
  throttle: (options) => buildThrottleCheckStep(options),

  circuitBreaker(options): Position {
    // Built once per route, so the window and the open/half-open machine are
    // the route's own; the controller still keys by route for a definition
    // shared across applications.
    const controller = new CircuitBreakerController(options);
    return {
      run(run) {
        const scoped: CircuitBreakerEventScope = {
          ...scopeOf(run),
          ...(controller.label !== undefined
            ? { label: controller.label }
            : {}),
        };
        return executeWithCircuitBreaker(
          controller,
          run.route,
          circuitBreakerEmitHooks(run, scoped, true, controller.options),
          () =>
            circuitOpenOutcome(
              run.exchange,
              controller.options,
              run.forward,
              `for route "${run.routeId}"`,
            ),
          () => run.attempt(run.abandon),
        );
      },
    };
  },

  retry(options): Position {
    return {
      run(run) {
        const scoped = scopeOf(run);
        return executeWithRetry(() => run.attempt(run.abandon), options, {
          // Intake, not execution: a backoff cut short surfaces the last
          // error as a terminal outcome rather than burning the shutdown
          // deadline on attempts that cannot finish.
          signal: run.signal,
          onStarted: () => {
            run.emit("route:retry:started", {
              ...scoped,
              maxAttempts: options.maxAttempts,
            });
          },
          onAttempt: (attemptNumber, waitMs, lastError) => {
            run.emit("route:retry:attempt", {
              ...scoped,
              attemptNumber,
              maxAttempts: options.maxAttempts,
              backoffMs: waitMs,
              lastError,
            });
          },
          onStopped: (attemptNumber, success, error) => {
            run.emit("route:retry:stopped", {
              ...scoped,
              attemptNumber,
              success,
              ...(error !== undefined ? { error } : {}),
            });
          },
        });
      },
    };
  },

  timeout(options): Position {
    const { timeoutMs } = options;
    return {
      async run(run) {
        const scoped = { ...scopeOf(run), timeoutMs };
        run.emit("route:timeout:started", scoped);
        const start = Date.now();
        const abandon = new AbortController();
        try {
          const outcome = await raceWithDeadline(
            run.attempt(
              run.abandon
                ? anySignal(run.abandon, abandon.signal)
                : abandon.signal,
            ),
            timeoutMs,
          );
          run.emit("route:timeout:stopped", {
            ...scoped,
            elapsed: Date.now() - start,
          });
          return outcome;
        } catch (err) {
          if (!(err instanceof DeadlineExceededError)) throw err;
          const timeoutError = rcError("RC5011", undefined, {
            message: `Route "${run.routeId}" pipeline exceeded its ${timeoutMs}ms timeout`,
          });
          // Stop the abandoned attempt: it schedules nothing further, and
          // its in-flight step sees the abort through its signal, with the
          // RC5011 as the reason.
          abandon.abort(timeoutError);
          run.emit("route:timeout:expired", {
            ...scoped,
            elapsed: Date.now() - start,
          });
          throw timeoutError;
        }
      },
    };
  },

  concurrency(options): Position {
    const controller = new ConcurrencyController(options);
    return {
      run(run) {
        const scoped: ConcurrencyEventScope = {
          ...scopeOf(run),
          ...(controller.label !== undefined
            ? { label: controller.label }
            : {}),
        };
        return executeWithConcurrency(
          controller,
          run.exchange,
          run.route,
          {
            // A queued attempt is released when shutdown begins or an outer
            // position abandons it, rather than waiting behind a slot that
            // will never free.
            signal: run.signal,
            ...concurrencyEmitHooks(run, scoped, true),
          },
          () => run.attempt(run.abandon),
          { mustWait: run.mustWait },
        );
      },
    };
  },
};

/** The plugin that provides {@link RESILIENCE}, installed by default. */
export function resiliencePlugin() {
  return definePlugin({
    id: "routecraft.resilience",
    provides: [RESILIENCE],
    bind(c) {
      c.provide(RESILIENCE, resilienceProvider);
    },
  });
}

registerDefaultPlugin("routecraft.resilience", resiliencePlugin);
