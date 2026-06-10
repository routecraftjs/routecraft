import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../context.ts";
import type { EventName } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  HeadersKeys,
  DefaultExchange,
} from "../exchange.ts";
import { rcError, RoutecraftError, formatSchemaIssues } from "../error.ts";
import type { ErrorHandler, ForwardFn, Route } from "../route.ts";

/**
 * Dependencies the validation helpers need from the owning route. Passed
 * explicitly so the helpers are free functions (moved verbatim from
 * DefaultRoute private methods; only `this.*` references became `deps.*`).
 */
export interface ValidationDeps {
  routeId: string;
  context: CraftContext;
  logger: { warn(obj: unknown, msg?: string): void };
  /** The owning route, surfaced on validation event payloads. */
  route: Route;
  errorHandler?: ErrorHandler;
  buildForward(): ForwardFn;
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
 * Validate an incoming exchange against the route's `input` schemas BEFORE
 * the pipeline runs (no `exchange:started` has fired yet).
 *
 * On success returns a (possibly new) exchange with validated / coerced
 * values; headers are merged over the originals so pass-through keys
 * like correlation IDs survive schemas that strip unknowns. On failure
 * emits `exchange:started` followed by `exchange:dropped` for telemetry
 * and throws an RC5002 error so the source's caller (e.g. a direct
 * channel's `send`) sees the rejection.
 *
 * MUST NOT be called after `handler()` has emitted `exchange:started` for
 * the exchange (e.g. from inside the synthetic parse step). Use
 * {@link validateInputOrThrow} for that path: it throws RC5002 without
 * emitting events, so the parse step's `step:failed` -> runSteps catch ->
 * `exchange:failed` lifecycle stays intact.
 */
export async function applyInputValidation(
  deps: ValidationDeps,
  exchange: Exchange,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): Promise<Exchange> {
  let current = exchange;
  if (schemas.body) {
    const res = await validateAgainst(schemas.body, current.body);
    if (!res.ok) {
      throw emitInputValidationFailure(deps, current, "body", res.message);
    }
    current = DefaultExchange.rewrap(current, { body: res.value });
  }
  if (schemas.headers) {
    const res = await validateAgainst(schemas.headers, current.headers);
    if (!res.ok) {
      throw emitInputValidationFailure(deps, current, "headers", res.message);
    }
    const headerValue = res.value as ExchangeHeaders | undefined;
    if (headerValue !== undefined) {
      // Merge validated values over the originals so caller pass-through
      // keys (correlation IDs, adapter-injected metadata) survive
      // schemas that strip unknowns.
      current = DefaultExchange.rewrap(current, {
        headers: { ...current.headers, ...headerValue },
      });
    }
  }
  return current;
}

/**
 * Same as {@link applyInputValidation} but without emitting any
 * `exchange:started` / `exchange:dropped` events on failure: just throws
 * RC5002. Used by the synthetic parse step in `runSteps` so a validation
 * failure becomes a normal step failure (`step:failed` -> `exchange:failed`)
 * rather than a duplicate `started` + stray `dropped` followed by a
 * `failed` (see #187).
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
 * Emit exchange:started followed by exchange:dropped for a message that
 * failed framework-level input validation and return the RC5002 error so
 * the caller can throw it. The source's own sender (e.g. a direct
 * channel's `send`) needs the rejection to propagate; pipeline telemetry
 * still sees the drop via the events.
 */
export function emitInputValidationFailure(
  deps: ValidationDeps,
  exchange: Exchange,
  direction: "body" | "headers",
  message: string,
): RoutecraftError {
  const routeId = deps.routeId;
  const correlationId = (exchange.headers[HeadersKeys.CORRELATION_ID] ??
    exchange.id) as string;

  const err = rcError("RC5002", new Error(message), {
    message: `${direction === "body" ? "Body" : "Header"} validation failed for route "${routeId}"`,
  });

  deps.context.emit(`route:${routeId}:exchange:started` as EventName, {
    routeId,
    exchangeId: exchange.id,
    correlationId,
  });
  deps.context.emit(`route:${routeId}:exchange:dropped` as EventName, {
    routeId,
    exchangeId: exchange.id,
    correlationId,
    reason: `input validation failed: ${message}`,
    exchange,
  });

  deps.logger.warn(
    { err, routeId, direction, operation: "from" },
    `Input ${direction} validation failed; exchange dropped`,
  );

  return err;
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

  deps.context.emit(`route:${routeId}:step:output:error` as EventName, {
    error,
    route: deps.route,
    exchange,
    operation: "output",
  });

  if (deps.errorHandler) {
    try {
      const forward = deps.buildForward();
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
      deps.context.emit(`route:${routeId}:error:caught` as EventName, {
        error,
        route: deps.route,
        exchange: recoveredExchange,
      });
      return { exchange: recoveredExchange, failed: false, dropped: false };
    } catch (handlerErr) {
      deps.context.emit(`route:${routeId}:exchange:failed` as const, {
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

  deps.context.emit(`route:${routeId}:exchange:failed` as const, {
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
