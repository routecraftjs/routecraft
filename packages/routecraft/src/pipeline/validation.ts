import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../context.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  HeadersKeys,
  DefaultExchange,
} from "../exchange.ts";
import { rcError, formatSchemaIssues } from "../error.ts";
import type { ErrorHandler, ForwardFn, Route } from "../route.ts";

/**
 * Dependencies the validation helpers need from the owning route. Passed
 * explicitly so the helpers are free functions (moved verbatim from
 * DefaultRoute private methods; only `this.*` references became `deps.*`).
 */
export interface ValidationDeps {
  routeId: string;
  context: CraftContext;
  /** The owning route, surfaced on validation event payloads. */
  route: Route;
  errorHandler?: ErrorHandler;
  /** Build a forward callable whose target inherits `caller`'s headers. */
  buildForward: (caller: Exchange) => ForwardFn;
}

/**
 * Run Standard Schema validation against a value. Returns the validated
 * value on success (schemas can legitimately transform to `undefined`,
 * so presence of the `value` key is what decides success, not truthiness)
 * or a human-readable message on failure.
 */
export async function validateAgainst(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let result = schema["~standard"].validate(value);
  if (result instanceof Promise) result = await result;
  const issues = (result as { issues?: unknown }).issues;
  if (issues !== undefined && issues !== null) {
    return { ok: false, message: formatSchemaIssues(issues) };
  }
  const successResult = result as { value?: unknown };
  return {
    ok: true,
    value: "value" in successResult ? successResult.value : value,
  };
}

/**
 * The route's terminal output stage: enforce `.output()` schemas on a run
 * that produced the route's output, or pass the result through untouched
 * when it did not.
 *
 * One implementation because there are two callers with identical rules
 * (`DefaultRoute.handler` for a source-driven run, `runDetachedPipeline`
 * for a debounce release or a resumed continuation), and the suspend work
 * proved they drift: both had to grow the same `suspended` exemption in
 * the same shape. A third terminal state, or any change to the failure
 * path, now lands once.
 *
 * A failed, dropped, or parked run is exempt. The first two never produced
 * an output; the third produced the `Suspended` acknowledgment, which is
 * deliberately not the declared output but the other arm of the route's
 * `Output | Suspended` type.
 *
 * @param deps - Route identity plus the route-scope error handler
 * @param schemas - The route's declared output schemas, if any
 * @param result - The run's result
 * @param startTime - Run start, for the failure path's duration
 * @returns The result, with a validated exchange or a failure recorded
 *
 * @internal
 */
export async function applyOutputStage<
  R extends {
    exchange: Exchange;
    failed: boolean;
    dropped: boolean;
    suspended: boolean;
    error?: unknown;
  },
>(
  deps: ValidationDeps,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 } | undefined,
  result: R,
  startTime: number,
): Promise<R> {
  if (result.failed || result.dropped || result.suspended) return result;
  if (!schemas?.body && !schemas?.headers) return result;
  try {
    return {
      ...result,
      exchange: await applyOutputValidation(deps, result.exchange, schemas),
    };
  } catch (err) {
    return {
      ...result,
      // `suspended` is false by construction: this arm only runs for a
      // result that reached validation.
      ...(await handleOutputValidationFailure(
        deps,
        result.exchange,
        err,
        startTime,
        schemas,
      )),
    };
  }
}

/**
 * Validate an exchange against the route's `input` schemas, throwing
 * `RC5002` on failure without emitting any lifecycle events: the caller
 * is a chain step inside `runPipeline`, so the failure becomes a normal
 * step failure (`step:failed` -> the error-handler-or-failed path).
 *
 * On success returns a (possibly new) exchange with validated / coerced
 * values; validated headers are merged over the originals so caller
 * pass-through keys (correlation IDs, adapter-injected metadata) survive
 * schemas that strip unknowns.
 *
 * Used by the synthetic parse step (input validates the parsed body) and
 * by the standalone synthetic input step for parser-less sources; both
 * paths sit at chain position #4, so `.error()` can recover an RC5002 for
 * every source shape (see #187, #447).
 */
export async function validateInputOrThrow(
  deps: ValidationDeps,
  exchange: Exchange,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): Promise<Exchange> {
  let current = exchange;
  if (schemas.body) {
    const res = await validateAgainst(schemas.body, current.body);
    if (!res.ok) {
      throw rcError("RC5002", new Error(res.message), {
        message: `Body validation failed for route "${deps.routeId}"`,
      });
    }
    current = DefaultExchange.rewrap(current, { body: res.value });
  }
  if (schemas.headers) {
    const res = await validateAgainst(schemas.headers, current.headers);
    if (!res.ok) {
      throw rcError("RC5002", new Error(res.message), {
        message: `Header validation failed for route "${deps.routeId}"`,
      });
    }
    const headerValue = res.value as ExchangeHeaders | undefined;
    if (headerValue !== undefined) {
      current = DefaultExchange.rewrap(current, {
        headers: { ...current.headers, ...headerValue },
      });
    }
  }
  return current;
}

/**
 * Handle an output-validation failure. Delegates to the route's error
 * handler when one is configured (mirroring how step errors recover);
 * otherwise emits `exchange:failed` and returns a failed result so the
 * caller can surface the error.
 */
export async function handleOutputValidationFailure(
  deps: ValidationDeps,
  exchange: Exchange,
  error: unknown,
  startTime: number,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): Promise<{
  exchange: Exchange;
  failed: boolean;
  dropped: boolean;
  error?: unknown;
}> {
  const routeId = deps.routeId;
  const correlationId = exchange.headers[HeadersKeys.CORRELATION_ID] as string;

  deps.context.emit("route:step:error", {
    routeId,
    error,
    route: deps.route,
    exchange,
    operation: "output",
  });

  if (deps.errorHandler) {
    try {
      const forward = deps.buildForward(exchange);
      const recovered = await deps.errorHandler(error, exchange, forward);
      // Re-validate the recovered body against the same output schemas
      // before declaring success. Without this, an `errorHandler` that
      // returns another invalid payload would silently bypass the
      // route's `.output()` contract and flow out via
      // `exchange:completed`. A second failure here cascades through
      // the existing handlerErr branch so the failure surfaces the
      // same way (`exchange:failed` plus the failure result).
      const recoveredExchange = await applyOutputValidation(
        deps,
        DefaultExchange.rewrap(exchange, { body: recovered }),
        schemas,
      );
      deps.context.emit("route:error:caught", {
        routeId,
        error,
        route: deps.route,
        exchange: recoveredExchange,
      });
      return { exchange: recoveredExchange, failed: false, dropped: false };
    } catch (handlerErr) {
      deps.context.emit("route:exchange:failed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        duration: Date.now() - startTime,
        error: handlerErr,
        exchange,
      });
      return { exchange, failed: true, dropped: false, error: handlerErr };
    }
  }

  deps.context.emit("route:exchange:failed", {
    routeId,
    exchangeId: exchange.id,
    correlationId,
    duration: Date.now() - startTime,
    error,
    exchange,
  });
  return { exchange, failed: true, dropped: false, error };
}

/**
 * Validate the final exchange against the route's `output` schemas.
 * On success returns the validated (possibly new) exchange. On failure
 * throws an RC5002 error so the normal error / error-handler flow takes
 * over.
 */
export async function applyOutputValidation(
  deps: ValidationDeps,
  exchange: Exchange,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): Promise<Exchange> {
  let current = exchange;
  if (schemas.body) {
    const res = await validateAgainst(schemas.body, current.body);
    if (!res.ok) {
      throw rcError("RC5002", new Error(res.message), {
        message: `Output body validation failed for route "${deps.routeId}"`,
      });
    }
    current = DefaultExchange.rewrap(current, { body: res.value });
  }
  if (schemas.headers) {
    const res = await validateAgainst(schemas.headers, current.headers);
    if (!res.ok) {
      throw rcError("RC5002", new Error(res.message), {
        message: `Output header validation failed for route "${deps.routeId}"`,
      });
    }
    const headerValue = res.value as ExchangeHeaders | undefined;
    if (headerValue !== undefined) {
      current = DefaultExchange.rewrap(current, {
        headers: { ...current.headers, ...headerValue },
      });
    }
  }
  return current;
}
