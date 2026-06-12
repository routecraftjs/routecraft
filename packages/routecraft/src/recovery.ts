import { markDropped, type Exchange } from "./exchange.ts";
import type { CraftContext } from "./context.ts";
import type { Route } from "./route.ts";

/**
 * Brand key marking a {@link Recovery} directive. `Symbol.for` so directives
 * survive crossing duplicate copies of the package (CLI vs user module).
 */
const RECOVERY = Symbol.for("routecraft.recovery");

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
 * Branded directive an error handler may return instead of a recovery
 * body. Plain return values (anything unbranded) keep their existing
 * meaning: they become the recovered exchange body. The brand makes the
 * directive unambiguous, so a handler that legitimately recovers with a
 * `{ kind: "drop" }`-shaped body is never misread; directives are only
 * created via the {@link recovery} helpers.
 */
export type Recovery = RecoveryDrop | RecoveryRethrow;

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
};

/** Type guard for {@link Recovery} directives. */
export function isRecovery(value: unknown): value is Recovery {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RECOVERY] === true
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
  scope: "route" | "step";
  /**
   * Owning route. Present at route scope, where the handler resolution
   * additionally emits `route:error:caught` (the event the docs attribute
   * to route-handler recovery); step scope never emitted it.
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

  markDropped(exchange);

  if (scope === "route" && route) {
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
    recoveryStrategy:
      scope === "route" ? "route-error-handler" : "step-error-handler",
    scope,
    ...(stepLabel !== undefined ? { stepLabel } : {}),
  });

  context.emit("route:exchange:dropped", {
    routeId,
    exchangeId: exchange.id,
    correlationId,
    reason,
    exchange,
  });
}
