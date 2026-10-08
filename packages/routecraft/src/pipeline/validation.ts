import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../context.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  HeadersKeys,
  DefaultExchange,
  markOutputValidated,
} from "../exchange.ts";
import { rcError, formatSchemaIssues } from "../error.ts";
import { isThenable } from "../shared/thenable.ts";
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
 *
 * Exported for adapter and plugin authors who validate at a protocol
 * boundary and need the failure as a message to hand back over the wire
 * rather than as a thrown error.
 *
 * The validated value carries the schema's output type, which for a
 * transforming schema is not the type that went in. `issues` accompanies
 * `message` so a caller can build a structured rejection (a JSON-RPC
 * `error.data`, an HTTP 422 field map) instead of only a sentence.
 *
 * Standard Schema allows `validate()` to return a thenable rather than a
 * real `Promise`, so awaiting one runs schema-author `then` code on this
 * path: a schema that never settles hangs the validation instead of
 * silently passing, which is the safer of the two failures. Nothing bounds
 * that wait. `.input()` is position #4 of the pre-from chain and `.timeout()`
 * is #8, so a route timeout sits below validation and cannot reclaim it.
 *
 * `schema` is assumed to carry a callable `~standard.validate`; this helper
 * dereferences it unguarded, so a caller holding a value from configuration
 * checks that first and chooses its own refusal.
 *
 * @param schema - The Standard Schema to validate with
 * @param value - The value to validate
 * @returns `{ ok: true, value }` with the validated (possibly transformed)
 *   value, or `{ ok: false, message, issues }` with the failure both
 *   formatted and raw. A schema that returns something other than a result
 *   record fails the same way, with an empty `issues` and a message naming
 *   what came back
 *
 * @example
 * ```ts
 * const result = await validateAgainst(schema, exchange.body);
 * if (!result.ok) return { isError: true, message: result.message };
 * ```
 */
export async function validateAgainst<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<
  | { ok: true; value: StandardSchemaV1.InferOutput<S> }
  | {
      ok: false;
      message: string;
      issues: readonly StandardSchemaV1.Issue[];
    }
> {
  let result: unknown = schema["~standard"].validate(value);
  if (isThenable(result)) result = await result;
  // After the await, so a sync schema, a thenable and a real `Promise` are
  // held to the same contract. A non-record fails three ways: `undefined`
  // and `null` die on the `issues` read, a primitive survives that and dies
  // on `"value" in successResult`, and an array clears both (it is a
  // non-null `object`) to reach the input fallback and report success on
  // unvalidated input. The message is written out rather than routed through
  // `formatSchemaIssues`, which renders an empty issue list as "[]".
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return {
      ok: false,
      message: `schema returned a malformed result: expected an object, received ${
        Array.isArray(result)
          ? "array"
          : result === null
            ? "null"
            : typeof result
      }`,
      issues: [],
    };
  }
  const issues = (result as { issues?: unknown }).issues;
  if (issues !== undefined && issues !== null) {
    return {
      ok: false,
      message: formatSchemaIssues(issues),
      // A non-array `issues` breaks the spec; report the failure without them.
      issues: Array.isArray(issues)
        ? (issues as readonly StandardSchemaV1.Issue[])
        : [],
    };
  }
  const successResult = result as { value?: unknown };
  return {
    ok: true,
    value: ("value" in successResult
      ? successResult.value
      : value) as StandardSchemaV1.InferOutput<S>,
  };
}

/**
 * The route's terminal output stage: enforce `.output()` schemas on a run
 * that produced the route's output, or pass the result through untouched
 * when it did not.
 *
 * One implementation because there are two callers with identical rules
 * (`DefaultRoute.handler` for a source-driven run, `runDetachedPipeline`
 * for a debounce release or a resumed continuation), and the defer work
 * proved they drift: both had to grow the same `deferred` exemption in
 * the same shape. A third terminal state, or any change to the failure
 * path, now lands once.
 *
 * A failed, dropped, or deferred run is exempt. The first two never produced
 * an output; the third produced the `Deferred` acknowledgment, which is
 * deliberately not the declared output but the other arm of the route's
 * `Output | Deferred` type.
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
    deferred: boolean;
    error?: unknown;
  },
>(
  deps: ValidationDeps,
  schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 } | undefined,
  result: R,
  startTime: number,
): Promise<R> {
  if (result.failed || result.dropped || result.deferred) return result;
  if (!schemas?.body && !schemas?.headers) return result;
  try {
    return {
      ...result,
      exchange: await applyOutputValidation(deps, result.exchange, schemas),
    };
  } catch (err) {
    return {
      ...result,
      // `deferred` is false by construction: this arm only runs for a
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
 * Machine-readable detail attached to an `RC5065` error's cause: which part
 * of the input failed the route's `.input()` schema, and the schema's own
 * issues. Read it off `error.cause` through {@link isInputValidationFailure}
 * to build a structured rejection instead of parsing the message:
 *
 * ```ts
 * if (isInputValidationFailure(err.cause)) {
 *   for (const issue of err.cause.invalid.issues) report(issue.path, issue.message)
 * }
 * ```
 *
 * The http doors (the `http()` source and the ops dispatch mount) send
 * `in` and each issue's path and message to the caller, so issue messages
 * are client-facing: a schema author's custom message reaches the wire
 * verbatim.
 *
 * In-process only, like `InsufficientAuthority`: `RoutecraftError.toJSON()`
 * serialises the cause's message and stack, not its own properties.
 */
export interface InputValidationFailure extends Error {
  invalid: {
    /** Which part of the input the schema refused. */
    in: "body" | "headers";
    /** The schema's issues, as it returned them. */
    issues: readonly StandardSchemaV1.Issue[];
    /**
     * The route whose `.input()` refused. A route calling another through
     * `direct()` receives the callee's RC5065 as its own step failure, and
     * what the callee refused was the caller route's output, not input
     * anyone outside supplied.
     */
    routeId: string;
  };
}

/**
 * Whether `value` (typically an RC5065 error's `cause`) carries the
 * {@link InputValidationFailure} detail.
 *
 * @param value - Any value, usually `error.cause`
 * @returns `true` when the value is an Error carrying a well-formed `invalid` detail
 */
export function isInputValidationFailure(
  value: unknown,
): value is InputValidationFailure {
  return (
    value instanceof Error &&
    isValidationDetail((value as { invalid?: unknown }).invalid)
  );
}

/**
 * The input failures the framework's validators raised. Membership cannot be
 * read back or copied onto another object, so a step throwing an `RC5065`
 * or `RC5049` with a hand-built detail cannot dress its own failure up as
 * the caller's.
 */
const RAISED = new WeakSet<object>();

/**
 * Whether `value` is an {@link InputValidationFailure} a framework validator
 * raised (`.input()`, the resume door), as opposed to the same shape built
 * by a step. What a door maps to the caller;
 * {@link isInputValidationFailure} reads the detail off any error.
 *
 * @internal
 */
export function isRaisedInputValidationFailure(
  value: unknown,
): value is InputValidationFailure {
  return isInputValidationFailure(value) && RAISED.has(value);
}

function isValidationDetail(detail: unknown): boolean {
  if (typeof detail !== "object" || detail === null) return false;
  const fields = detail as Record<string, unknown>;
  return (
    (fields["in"] === "body" || fields["in"] === "headers") &&
    Array.isArray(fields["issues"]) &&
    typeof fields["routeId"] === "string"
  );
}

/**
 * Machine-readable detail attached to the cause of an error raised because a
 * result broke its declared output schema: which part failed, the schema's
 * own issues, and the route or tool. Read it off `error.cause` through
 * {@link isOutputValidationFailure}.
 *
 * Two checks attach it: a route's `.output()` (`RC5002`) and the MCP
 * server's check of a tool result against the `outputSchema` it advertised
 * (`AI2001`, for a tool the pipeline did not validate). `RC5002` also covers
 * a mid-pipeline `.validate()` and an empty aggregation, whose causes carry
 * no such detail, so its presence is what tells a door the result broke a
 * declared contract. The MCP server sends the body issues to the caller,
 * because the tool advertised that schema.
 *
 * In-process only, like {@link InputValidationFailure}.
 */
export interface OutputValidationFailure extends Error {
  invalidOutput: {
    /** Which part of the result the schema refused. */
    in: "body" | "headers";
    /** The schema's issues, as it returned them. */
    issues: readonly StandardSchemaV1.Issue[];
    /**
     * The route whose `.output()` refused, or the tool whose advertised
     * schema refused. A route calling another through `direct()` receives
     * the callee's RC5002 as its own step failure.
     */
    routeId: string;
  };
}

/**
 * Whether `value` (typically an RC5002 error's `cause`) carries the
 * {@link OutputValidationFailure} detail.
 *
 * @param value - Any value, usually `error.cause`
 * @returns `true` when the value is an Error carrying a well-formed `invalidOutput` detail
 */
export function isOutputValidationFailure(
  value: unknown,
): value is OutputValidationFailure {
  return (
    value instanceof Error &&
    isValidationDetail((value as { invalidOutput?: unknown }).invalidOutput)
  );
}

/**
 * The cause of an output RC5002. A schema that failed without issues broke
 * its own contract rather than the route's output, so it gets no detail and
 * no door reports it as a declared-schema violation.
 */
function outputValidationFailure(
  message: string,
  part: "body" | "headers",
  issues: readonly StandardSchemaV1.Issue[],
  routeId: string,
): Error {
  const cause = new Error(message);
  return issues.length === 0
    ? cause
    : Object.assign(cause, { invalidOutput: { in: part, issues, routeId } });
}

/**
 * Validate an exchange against the route's `input` schemas, throwing
 * `RC5065` on failure without emitting any lifecycle events: the caller
 * is a chain step inside `runPipeline`, so the failure becomes a normal
 * step failure (`route:step:failed` -> the error-handler-or-failed path).
 *
 * The error's cause is an {@link InputValidationFailure} naming the part
 * that failed and the schema's issues, unless the schema failed without
 * any, which is the schema's fault and carries no detail.
 *
 * On success returns a (possibly new) exchange with validated / coerced
 * values; validated headers are merged over the originals so caller
 * pass-through keys (correlation IDs, adapter-injected metadata) survive
 * schemas that strip unknowns.
 *
 * Used by the synthetic parse step (input validates the parsed body) and
 * by the standalone synthetic input step for parser-less sources; both
 * paths sit at chain position #4, so `.error()` can recover an RC5065 for
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
      throw rcError(
        "RC5065",
        inputValidationFailure(res.message, "body", res.issues, deps.routeId),
        {
          message: `Body validation failed for route "${deps.routeId}": ${res.message}`,
        },
      );
    }
    current = DefaultExchange.rewrap(current, { body: res.value });
  }
  if (schemas.headers) {
    const res = await validateAgainst(schemas.headers, current.headers);
    if (!res.ok) {
      throw rcError(
        "RC5065",
        inputValidationFailure(
          res.message,
          "headers",
          res.issues,
          deps.routeId,
        ),
        {
          message: `Header validation failed for route "${deps.routeId}": ${res.message}`,
        },
      );
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
 * The cause of an RC5065, or of the resume door's RC5049. A schema that
 * failed without issues broke its own contract rather than refused the
 * caller, so it gets no detail and no door answers it as a caller refusal.
 *
 * @internal
 */
export function inputValidationFailure(
  message: string,
  part: "body" | "headers",
  issues: readonly StandardSchemaV1.Issue[],
  routeId: string,
): Error {
  const cause = new Error(message);
  if (issues.length === 0) return cause;
  RAISED.add(cause);
  return Object.assign(cause, { invalid: { in: part, issues, routeId } });
}

/**
 * Handle an output-validation failure. Delegates to the route's error
 * handler when one is configured (mirroring how step errors recover);
 * otherwise emits `route:exchange:failed` and returns a failed result so the
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
      // `route:exchange:completed`. A second failure here cascades through
      // the existing handlerErr branch so the failure surfaces the
      // same way (`route:exchange:failed` plus the failure result).
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
      throw rcError(
        "RC5002",
        outputValidationFailure(res.message, "body", res.issues, deps.routeId),
        {
          message: `Output body validation failed for route "${deps.routeId}"`,
        },
      );
    }
    current = DefaultExchange.rewrap(current, { body: res.value });
    markOutputValidated(current, schemas.body);
  }
  if (schemas.headers) {
    const res = await validateAgainst(schemas.headers, current.headers);
    if (!res.ok) {
      throw rcError(
        "RC5002",
        outputValidationFailure(
          res.message,
          "headers",
          res.issues,
          deps.routeId,
        ),
        {
          message: `Output header validation failed for route "${deps.routeId}"`,
        },
      );
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
