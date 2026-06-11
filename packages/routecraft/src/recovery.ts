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
