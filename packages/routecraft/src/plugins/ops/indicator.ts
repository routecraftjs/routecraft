/**
 * Indicator handles: the one thing an app writes by hand for health.
 *
 * Routes, circuit breakers and the serving lifecycle are all derived from
 * events the framework already emits, so an app that only wants those writes
 * no code at all. An indicator exists for the other case: a dependency whose
 * health the framework cannot see, such as a mailbox, a third-party API, or a
 * licence server.
 */

import { rcError } from "../../error";
import type { CraftContext } from "../../context";
import type { HealthState } from "./state";
import type { Indicator, IndicatorDefinition } from "./types";

interface Bound {
  ctx: CraftContext;
  state: HealthState;
}

/**
 * The binding side-channel, keyed by handle.
 *
 * Kept off the handle object so `Indicator` stays a plain read-and-push
 * surface: a hand-written object satisfying `Indicator` structurally is
 * therefore detectable (it has no entry here) rather than crashing on a
 * missing method when the plugin tries to bind it.
 */
const binders = new WeakMap<Indicator, Bound[]>();

/**
 * Bind a handle to a context's ledger. Bindings are keyed by context, never
 * held in a single slot, because one plugin instance may serve several
 * contexts in a process.
 *
 * @internal
 */
export function bindIndicator(
  indicator: Indicator,
  ctx: CraftContext,
  state: HealthState,
): void {
  const bound = binders.get(indicator);
  if (!bound) {
    throw rcError("RC5053", undefined, {
      message: `Indicator "${indicator.name}" was not created by defineIndicator(). ops.indicators takes handles from defineIndicator({ name }); an object of the same shape has no ledger to report into.`,
    });
  }
  const existing = bound.findIndex((entry) => entry.ctx === ctx);
  if (existing >= 0) bound.splice(existing, 1);
  bound.push({ ctx, state });
}

/**
 * Release a handle's binding to one context.
 *
 * @internal
 */
export function unbindIndicator(indicator: Indicator, ctx: CraftContext): void {
  const bound = binders.get(indicator);
  if (!bound) return;
  const index = bound.findIndex((entry) => entry.ctx === ctx);
  if (index >= 0) bound.splice(index, 1);
}

/**
 * Whether this handle came from {@link defineIndicator}.
 *
 * @internal
 */
export function isIndicator(indicator: Indicator): boolean {
  return binders.has(indicator);
}

/**
 * Declare an indicator: a named dependency whose health the app reports.
 *
 * The returned handle is both the declaration and the push surface, and it is
 * inert until an ops plugin binds it to a context. Register it through
 * `ops.indicators` so a push has a ledger to land in; a handle that is never
 * registered is reported at context start, where the message can name the fix,
 * rather than by throwing from whatever step happened to push it.
 *
 * Two ways to report, and the first needs no code in the route:
 *
 * ```typescript
 * // Bound to a probe route: a completed exchange reports up, a failed one
 * // reports down, and no exchange within maxAgeMs goes stale.
 * export const mailHealth = defineIndicator({
 *   name: "mail",
 *   maxAgeMs: 15 * 60_000,
 *   route: "probe-mail",
 * });
 *
 * // Pushed by hand, from any .process() or .error() step.
 * mailHealth.down({ subsystem: "imap" });
 * ```
 *
 * A handle used against several live contexts reports into each of their
 * ledgers, because a push carries no context of its own and routecraft exposes
 * no ambient accessor inside an `.error()` handler. In the ordinary
 * single-context process that is exactly one ledger.
 *
 * Pushing through an unbound handle is deliberately inert rather than a throw.
 * Health instrumentation must not be able to kill the code it instruments: an
 * exchange draining during shutdown, after teardown released the binding, would
 * otherwise take an error out of its `.error()` handler and into the route.
 *
 * @param definition - Name, optional staleness window, failure domain, and
 *   optional route binding.
 * @returns A handle to register in `ops.indicators` and push through.
 */
export function defineIndicator(definition: IndicatorDefinition): Indicator {
  if (definition.name.trim() === "") {
    throw rcError("RC5053", undefined, {
      message: "defineIndicator: name must not be empty.",
    });
  }
  if (definition.maxAgeMs !== undefined && definition.maxAgeMs <= 0) {
    throw rcError("RC5053", undefined, {
      message: `defineIndicator("${definition.name}"): maxAgeMs must be a positive number of milliseconds.`,
    });
  }

  const bound: Bound[] = [];
  const frozen: Readonly<IndicatorDefinition> = Object.freeze({
    ...definition,
  });

  const indicator: Indicator = {
    name: definition.name,
    definition: frozen,
    up(details) {
      for (const entry of bound) {
        entry.state.reportIndicator(definition.name, {
          status: "up",
          ...(details !== undefined ? { details } : {}),
        });
      }
    },
    down(details) {
      for (const entry of bound) {
        entry.state.reportIndicator(definition.name, {
          status: "down",
          ...(details !== undefined ? { details } : {}),
        });
      }
    },
    inactive() {
      for (const entry of bound) {
        entry.state.setIndicatorInactive(definition.name, true);
      }
    },
  };

  binders.set(indicator, bound);
  return indicator;
}
