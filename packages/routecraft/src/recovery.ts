import { markDropped, emitExchangeDropped, type Exchange } from "./exchange.ts";
import { BRAND, isBranded } from "./brand.ts";
import type { CraftContext } from "./context.ts";
import type { Route } from "./route.ts";
import type { ErrorHandlerScope } from "./types.ts";
import type { Deferred } from "./deferral/deferred.ts";
import type { DeferSignalRequest } from "./deferral/signal.ts";

/**
 * Brand key marking a {@link Recovery} directive. Registered in
 * {@link BRAND} (`Symbol.for`) so directives survive crossing duplicate
 * copies of the package (CLI vs user module).
 */
const RECOVERY = BRAND.Recovery;

/**
 * Directive returned from an {@link ErrorHandler} to drop the failing
 * exchange instead of recovering with a body. The engine marks the
 * exchange dropped and emits `route:exchange:dropped` with `reason`;
 * `exchange:completed` does not fire and no recovery body is produced.
 */
export interface RecoveryDrop {
  readonly [RECOVERY]: true;
  readonly kind: "drop";
  readonly reason: string;
}

/**
 * Directive returned from an {@link ErrorHandler} to propagate the
 * original error, declining recovery. Equivalent to `throw error` inside
 * the handler: the engine follows the handler-threw path
 * (`route:error-handler:failed`, then the route-level cascade for
 * step-scope handlers or the `exchange:failed` path for route scope).
 */
export interface RecoveryRethrow {
  readonly [RECOVERY]: true;
  readonly kind: "rethrow";
}

/**
 * What `recovery.defer()` takes: everything a {@link DeferSignalRequest}
 * declares, plus the notification the framework owns the timing of.
 *
 * The site is deliberately absent. A handler runs outside the step tree and
 * has no position of its own, so the executor resolves the site from
 * whatever failed; a handler that could name one could park a continuation
 * the route never reaches.
 */
export interface ErrorPathDeferRequest extends DeferSignalRequest {
  /**
   * Tell someone the exchange parked, once the park is real.
   *
   * Awaited by the executor AFTER the record is written and BEFORE
   * `route:exchange:deferred` fires, and handed the same acknowledgment the
   * caller receives, token included.
   *
   * After the record is the safety property: the site is resolved when the
   * executor receives the directive, which is after the handler has run, so
   * a handler that notified first could hand a human a correctly signed
   * token for a park RC5051 then refuses, and nothing retires a dead link in
   * an inbox.
   *
   * Before the event is the exactly-one-terminal-event invariant: this hook
   * failing denies the record and fails the run with RC5067, so a park
   * announced first would be contradicted by the failure that follows it.
   *
   * The OPPOSITE of `deferAside`'s `announce`, which commits BEFORE its
   * store write because an aside deferral carries no expiry, so a crash
   * between the two must leave a reference to release rather than a record
   * nothing points at. Two orderings, two names, on purpose: one announces
   * an id to an in-process caller, the other hands a token to a person.
   *
   * Bounded by the deferring route's own abort signal, widened by an
   * enclosing `.timeout()`, because it is awaited inside the executor with a
   * network call in it: an unsettled hook holds the step, which holds
   * `drain()`, and its latency is caller-visible. A throw and an abort are
   * treated alike: the record is denied claim-first, so no live link
   * survives a notification that did not go out, and the exchange reaches
   * the ordinary failure path with the notify failure as cause.
   *
   * Do the sending by forwarding to a route the application owns rather than
   * calling a mailer here. `forward` carries the parked exchange's principal
   * BY REFERENCE, so that route runs under the same authority the parked
   * work did.
   */
  readonly notify?: (ack: Deferred) => void | Promise<void>;
}

/**
 * Directive returned from an {@link ErrorHandler} to park the failing
 * exchange durably instead of recovering with a body, dropping it, or
 * rethrowing.
 *
 * The exchange is written to the deferral store and execution one answers
 * with the {@link Deferred} acknowledgment, exactly as a `.defer()` step
 * does. Where it parks is the executor's decision, not the handler's: the
 * failing step's own position re-entrantly, or position 0 as admission when
 * the failure came from outside the step tree.
 */
export interface RecoveryDefer {
  readonly [RECOVERY]: true;
  readonly kind: "defer";
  readonly request: ErrorPathDeferRequest;
}

/**
 * Branded directive an error handler may return instead of a recovery
 * body. Plain return values (anything unbranded) keep their existing
 * meaning: they become the recovered exchange body. The brand makes the
 * directive unambiguous, so a handler that legitimately recovers with a
 * `{ kind: "drop" }`-shaped body is never misread; directives are only
 * created via the {@link recovery} helpers.
 */
export type Recovery = RecoveryDrop | RecoveryRethrow | RecoveryDefer;

/**
 * Helpers for building {@link Recovery} directives inside `.error()`
 * handlers (route scope and step scope alike).
 *
 * @example
 * ```ts
 * craft()
 *   .error((err, ex) =>
 *     isTransient(err) ? recovery.rethrow() : recovery.drop("poison message"),
 *   )
 *   .from(source)
 * ```
 */
export const recovery = {
  /**
   * Drop the failing exchange. The `reason` surfaces on the
   * `route:exchange:dropped` event (and the TUI), mirroring filter drop
   * semantics.
   */
  drop(reason = "error-handler-drop"): RecoveryDrop {
    return { [RECOVERY]: true, kind: "drop", reason };
  },

  /**
   * Decline recovery and propagate the original error, exactly as if the
   * handler had thrown it.
   */
  rethrow(): RecoveryRethrow {
    return { [RECOVERY]: true, kind: "rethrow" };
  },

  /**
   * Park the failing exchange durably and answer with the `Deferred`
   * acknowledgment.
   *
   * Turns an error into a deferral, which is what lets something OUTSIDE
   * the route decide that a failure is worth waiting on: a context handler
   * recognising an `RC5038` refusal can park the call, have a human lend the
   * missing scope, and let the continuation finish, without the route that
   * refused knowing any of it happened.
   *
   * @example
   * ```ts
   * ctx.registerHandler("error", (error, exchange, forward) => {
   *   const refusal = insufficientAuthorityOf(error);
   *   if (!refusal) return undefined;
   *   return recovery.defer({
   *     schema: decision,
   *     ttl: "4h",
   *     notify: (ack) => forward(sendStepUpMail, { token: ack.token }),
   *   });
   * });
   * ```
   */
  defer(request: ErrorPathDeferRequest): RecoveryDefer {
    return { [RECOVERY]: true, kind: "defer", request };
  },
};

/**
 * Type guard for {@link Recovery} directives. Checks the brand AND the
 * directive shape: a branded object with an unknown `kind` (e.g. a
 * hand-built object reusing the `Symbol.for` brand) must not pass as a
 * directive, so only the known shapes are accepted; anything else keeps
 * its plain-recovery-body meaning.
 */
export function isRecovery(value: unknown): value is Recovery {
  if (!isBranded(value, RECOVERY)) return false;
  const directive = value as {
    kind?: unknown;
    reason?: unknown;
    request?: unknown;
  };
  return (
    directive.kind === "rethrow" ||
    (directive.kind === "drop" && typeof directive.reason === "string") ||
    (directive.kind === "defer" &&
      typeof directive.request === "object" &&
      directive.request !== null)
  );
}

/**
 * Apply a {@link RecoveryDrop} directive on behalf of an error handler:
 * mark the exchange dropped and emit the recovery lifecycle events. The
 * single implementation keeps route-scope (pipeline executor) and
 * step-scope (ErrorWrapperStep) drop semantics identical.
 *
 * Marks BEFORE emitting so a subscriber observing the events sees
 * `isDropped(exchange) === true`; the route engine reads the flag to skip
 * `exchange:completed`.
 *
 * @internal
 */
export function applyDropDirective(args: {
  context: CraftContext;
  routeId: string;
  exchange: Exchange;
  /** The error the handler was invoked with. */
  originalError: unknown;
  /** Step label of the operation that failed. */
  failedOperation: string;
  correlationId: string;
  /** Drop reason from the directive, surfaced on `route:exchange:dropped`. */
  reason: string;
  scope: ErrorHandlerScope;
  /**
   * Owning route. Present at route and context scope, where the handler
   * resolution additionally emits `route:error:caught` (the event the docs
   * attribute to route-handler recovery); step scope never emitted it.
   */
  route?: Route;
  stepLabel?: string;
}): void {
  const {
    context,
    routeId,
    exchange,
    originalError,
    failedOperation,
    correlationId,
    reason,
    scope,
    route,
    stepLabel,
  } = args;

  // Mark eagerly (ahead of the final mark-and-emit below) so subscribers
  // to `route:error:caught`, whose payload carries the exchange, already
  // observe `isDropped(exchange) === true`.
  markDropped(exchange);

  // Step scope never emitted it, and still does not: a wrapper recovering
  // one step is not the route catching a failure.
  if (scope !== "step" && route) {
    context.emit("route:error:caught", {
      routeId,
      error: originalError,
      route,
      exchange,
    });
  }

  context.emit("route:error-handler:recovered", {
    routeId,
    exchangeId: exchange.id,
    correlationId,
    originalError,
    failedOperation,
    recoveryStrategy: `${scope}-error-handler`,
    scope,
    ...(stepLabel !== undefined ? { stepLabel } : {}),
  });

  emitExchangeDropped(context, {
    routeId,
    correlationId,
    reason,
    exchange,
  });
}
