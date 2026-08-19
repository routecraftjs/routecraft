import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isBranded, setBrand } from "../brand.ts";
import { rcError } from "../error.ts";
import type { Exchange } from "../exchange.ts";
import type { StepOutcome } from "../types.ts";
import { type Duration, parseDuration } from "./duration.ts";
import type { SuspendCapableStep } from "./sites.ts";

/**
 * What a suspend-capable adapter resolves when it raises a suspension from
 * inside its own execution: the same pieces `.suspend({ expect, ttl })`
 * declares statically, plus the closure state only the step can produce.
 */
export interface SuspendSignalRequest {
  /**
   * Schema describing what a valid answer looks like. Folded into the
   * continuation hash and rendered onto the `Suspended` acknowledgment. For
   * a re-entrant site it is descriptive only at resume time: the live
   * schema exists in the raising step's own code and cannot be read back
   * off the route, so revival delivers the raw answer and the step is the
   * validator. See `SuspendSite.reentrant`.
   */
  readonly expect: StandardSchemaV1;
  /** How long the suspension stays resumable. Absent means the context default. */
  readonly ttl?: Duration;
  /** Human-facing question carried onto the `Suspended` acknowledgment. */
  readonly question?: string;
  /** Machine-facing reason carried onto the `Suspended` acknowledgment. */
  readonly reason?: string;
  /**
   * Closure state owned by the raising step, persisted verbatim in the
   * record's `stepState` slot and handed back to the step when the
   * exchange resumes. Subject to the same plain-JSON rule as the exchange
   * (`RC5042`).
   */
  readonly stepState?: unknown;
}

/**
 * The throwable a suspend-capable adapter raises to park the exchange it is
 * executing.
 *
 * An `Error` subclass on purpose: the signal is control flow, and the
 * `.to()` / `.enrich()` step that hosts the site converts it into the
 * ordinary `suspend` StepOutcome before any wrapper can observe it, but a
 * signal raised somewhere without a revivable site (a `.tap()` snapshot, an
 * unbuilt route, a synthetic dispatch) surfaces as a legible failure rather
 * than an opaque thrown object.
 *
 * Never `instanceof`-checked: the brand survives duplicate copies of this
 * package in one process, which is the same reason every other framework
 * brand uses `Symbol.for`.
 */
export class SuspendSignal extends Error {
  override readonly name = "SuspendSignal";
  readonly request: SuspendSignalRequest;

  constructor(request: SuspendSignalRequest) {
    super(
      "A durable suspension was raised from a step without a revivable suspend site. " +
        "A suspension can only park from a .to() / .enrich() step of a built route's " +
        "primary flow (or a .choice() branch of it): not from a .tap() snapshot, a " +
        ".multicast() path, a .dispatch() target, inside a .split() fan-out, or a " +
        "dispatch that never entered a route.",
    );
    this.request = request;
    setBrand(this, BRAND.SuspendSignal);
  }
}

/**
 * Whether a thrown value is the framework's own {@link SuspendSignal}.
 *
 * Public alongside {@link SuspendSignal} for the same audience: a runtime
 * hosting suspend-capable steps (the agent tier is the shipped one) uses it
 * to let a raised suspension pass through its own error accounting instead
 * of reporting a park as a failure.
 */
export function isSuspendSignal(value: unknown): value is SuspendSignal {
  return isBranded(value, BRAND.SuspendSignal);
}

/**
 * Convert a caught {@link SuspendSignal} into the ordinary `suspend`
 * StepOutcome, or refuse it where no revivable site exists.
 *
 * Called by the `.to()` / `.enrich()` step that hosts the site, INSIDE its
 * own `execute`, which is the property that keeps step-scope wrappers
 * honest: a retry wrapper that saw the raw throw would re-run the step and
 * charge the work twice, so by the time any wrapper observes anything, the
 * suspension is already an outcome wrappers pass through.
 *
 * @throws RC5051 when the step has no site: it sits inside a `.split()`
 *   fan-out or a sealed side flow (the walk recorded why), or the signal
 *   was raised somewhere that never went through a built route.
 *
 * @internal
 */
export function convertSuspendSignal(
  host: Pick<SuspendCapableStep, "suspendSite" | "suspendRefusal">,
  exchange: Exchange,
  signal: SuspendSignal,
): StepOutcome {
  const site = host.suspendSite;
  if (!site) {
    throw rcError("RC5051", signal, {
      message: host.suspendRefusal ?? signal.message,
    });
  }
  const { expect, ttl, question, reason, stepState } = signal.request;
  return {
    kind: "suspend",
    exchange,
    request: {
      expect,
      ...(ttl !== undefined
        ? { expiresInMs: parseDuration(ttl, "suspend({ ttl })") }
        : {}),
      ...(question !== undefined ? { question } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(stepState !== undefined ? { stepState } : {}),
      site,
    },
  };
}
