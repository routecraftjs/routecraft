/**
 * Indicator handles: the one thing an app writes by hand for health.
 *
 * Routes, circuit breakers and the serving lifecycle are all derived from
 * events the framework already emits, so an app that only wants those writes
 * no code at all. An indicator exists for the other case: a dependency whose
 * health the framework cannot see, such as a mailbox, a third-party API, or a
 * licence server.
 */

import { parseDuration } from "../../shared/duration.ts";
import { rejectStaleOptions } from "../../shared/stale-options.ts";
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
 * Every handle `defineIndicator` produced, so the plugin can report the ones
 * an app forgot to register. Strongly held on purpose: handles are
 * module-scope constants whose lifetime is the process anyway, and the set is
 * bounded by how many an app declares in source.
 */
const declared = new Set<Indicator>();

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
  // Callers validate with `isIndicator` before binding, so a missing entry
  // cannot happen here; the plugin owns the refusal and its message.
  const bound = binders.get(indicator)!;
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
export function isIndicator(value: unknown): value is Indicator {
  return (
    typeof value === "object" &&
    value !== null &&
    binders.has(value as Indicator)
  );
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
 * // reports down, and no exchange within maxAge goes stale.
 * export const mailHealth = defineIndicator({
 *   name: "mail",
 *   maxAge: "15m",
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
  // The name is the report key and one path segment of
  // `/health/indicators/<name>`. A slash would split that segment, and `.` or
  // `..` are eaten by URL normalisation before the handler ever sees them, so
  // either way the component is unreachable at its own path: a typo that
  // would otherwise present as an endpoint that is simply missing.
  if (
    definition.name === "." ||
    definition.name === ".." ||
    definition.name !== encodeURIComponent(definition.name)
  ) {
    throw rcError("RC5053", undefined, {
      message: `defineIndicator("${definition.name}"): name must be usable as a single URL path segment. It is the key in the health report and the last segment of /health/indicators/<name>, so it cannot contain a slash, a space, or any character needing percent-encoding.`,
    });
  }
  // Parsed for its refusal, not its value: the resolved milliseconds are
  // computed again where the indicator registers. Validating here is what
  // makes a malformed duration fail at definition rather than at boot.
  rejectStaleOptions(definition, `defineIndicator("${definition.name}")`);
  if (definition.maxAge !== undefined) {
    try {
      parseDuration(definition.maxAge, "maxAge");
    } catch {
      throw rcError("RC5053", undefined, {
        message: `defineIndicator("${definition.name}"): maxAge must be a positive, finite duration.`,
      });
    }
  }

  const bound: Bound[] = [];
  const frozen: Readonly<IndicatorDefinition> = Object.freeze({
    ...definition,
  });

  const indicator: Indicator = {
    name: frozen.name,
    definition: frozen,
    up(details) {
      for (const entry of bound) {
        entry.state.reportIndicator(frozen.name, {
          status: "up",
          ...(details !== undefined ? { details } : {}),
        });
      }
    },
    down(details) {
      for (const entry of bound) {
        entry.state.reportIndicator(frozen.name, {
          status: "down",
          ...(details !== undefined ? { details } : {}),
        });
      }
    },
    inactive() {
      for (const entry of bound) {
        entry.state.setIndicatorInactive(frozen.name, true);
      }
    },
  };

  binders.set(indicator, bound);
  declared.add(indicator);
  return indicator;
}

/**
 * Names of handles this process declared that NO context has bound.
 *
 * Forgetting one entry in `ops.indicators` is the likeliest mistake with a
 * two-step API and the one that fails silently: the route keeps pushing, the
 * report never grows the key, and nothing pages.
 *
 * Deliberately not per-context. Several independently configured contexts can
 * share this module, and a handle registered by one of them is not something
 * the others forgot; asking every context about every handle would tell an app
 * to register another app's. Only a handle nobody anywhere registered is a
 * mistake, and that is what this reports.
 *
 * @internal
 */
export function unboundIndicators(): string[] {
  return [...declared]
    .filter((handle) => (binders.get(handle) ?? []).length === 0)
    .map((handle) => handle.name);
}
