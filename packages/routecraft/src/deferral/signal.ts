import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isBranded, setBrand } from "../brand.ts";
import { rcError } from "../error.ts";
import type { Exchange } from "../exchange.ts";
import type { StepOutcome } from "../types.ts";
import { type Duration, parseDuration } from "../shared/duration.ts";
import type { DeferCapableStep } from "./sites.ts";

/**
 * What a defer-capable adapter resolves when it raises a deferral from
 * inside its own execution: the same pieces `.defer({ schema, ttl })`
 * declares statically, plus the closure state only the step can produce.
 */
export interface DeferSignalRequest {
  /**
   * Schema describing what a valid resume payload looks like. Optional: absent
   * declares no contract at all, and the descriptor records that, so a site
   * edited from a declared schema to none moves the digest rather than
   * quietly accepting anything.
   *
   * Folded into the continuation hash and rendered onto the `Deferred`
   * acknowledgment. For a re-entrant site it is descriptive only at resume
   * time: the live schema exists in the raising step's own code and cannot
   * be read back off the route, so revival delivers the raw payload and the
   * step is the validator. See `DeferSite.reentrant`.
   */
  readonly schema?: StandardSchemaV1;
  /** How long the deferral stays resumable. Absent means the context default. */
  readonly ttl?: Duration;
  /**
   * Anything the resuming route needs to decide who may resume. Plain
   * JSON, persisted verbatim, never interpreted by the framework.
   */
  readonly meta?: unknown;
  /**
   * Identity of the call this park belongs to, so a batch that mints one
   * credential per call cannot have one call's recipient resume another's
   * park.
   */
  readonly callBinding?: string;
  /**
   * Closure state owned by the raising step, persisted verbatim in the
   * record's `stepState` slot and handed back to the step when the
   * exchange resumes. Subject to the same plain-JSON rule as the exchange
   * (`RC5042`).
   */
  readonly stepState?: unknown;
}

/**
 * The throwable a defer-capable adapter raises to park the exchange it is
 * executing.
 *
 * An `Error` subclass on purpose: the signal is control flow, and the
 * `.to()` / `.enrich()` step that hosts the site converts it into the
 * ordinary `defer` StepOutcome before any wrapper can observe it, but a
 * signal raised somewhere without a revivable site (a `.tap()` snapshot, an
 * unbuilt route, a synthetic dispatch) surfaces as a legible failure rather
 * than an opaque thrown object.
 *
 * Never `instanceof`-checked: the brand survives duplicate copies of this
 * package in one process, which is the same reason every other framework
 * brand uses `Symbol.for`.
 */
export class DeferSignal extends Error {
  override readonly name = "DeferSignal";
  readonly request: DeferSignalRequest;

  constructor(request: DeferSignalRequest) {
    super(
      "A durable deferral was raised from a step without a revivable defer site. " +
        "A deferral can only park from a .to() / .enrich() step of a built route's " +
        "primary flow (or a .choice() branch of it): not from a .tap() snapshot, a " +
        ".multicast() path, a .dispatch() target, inside a .split() fan-out, or a " +
        "dispatch that never entered a route.",
    );
    this.request = request;
    setBrand(this, BRAND.DeferSignal);
  }
}

/**
 * Whether a thrown value is the framework's own {@link DeferSignal}.
 *
 * Public alongside {@link DeferSignal} for the same audience: a runtime
 * hosting defer-capable steps (the agent tier is the shipped one) uses it
 * to let a raised deferral pass through its own error accounting instead
 * of reporting a park as a failure.
 */
export function isDeferSignal(value: unknown): value is DeferSignal {
  return isBranded(value, BRAND.DeferSignal);
}

/**
 * Convert a caught {@link DeferSignal} into the ordinary `defer`
 * StepOutcome, or refuse it where no revivable site exists.
 *
 * Called by the `.to()` / `.enrich()` step that hosts the site, INSIDE its
 * own `execute`, which is the property that keeps step-scope wrappers
 * honest: a retry wrapper that saw the raw throw would re-run the step and
 * charge the work twice, so by the time any wrapper observes anything, the
 * deferral is already an outcome wrappers pass through.
 *
 * @throws RC5051 when the step has no site: it sits inside a `.split()`
 *   fan-out or a sealed side flow (the walk recorded why), or the signal
 *   was raised somewhere that never went through a built route.
 *
 * @internal
 */
export function convertDeferSignal(
  host: Pick<DeferCapableStep, "deferSite" | "deferRefusal">,
  exchange: Exchange,
  signal: DeferSignal,
): StepOutcome {
  const site = host.deferSite;
  if (!site) {
    throw rcError("RC5051", signal, {
      message: host.deferRefusal ?? signal.message,
    });
  }
  const { schema, ttl, stepState, meta, callBinding } = signal.request;
  return {
    kind: "defer",
    exchange,
    request: {
      ...(schema !== undefined ? { schema } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(callBinding !== undefined ? { callBinding } : {}),
      ...(ttl !== undefined
        ? { expiresInMs: parseDuration(ttl, "defer({ ttl })") }
        : {}),
      ...(stepState !== undefined ? { stepState } : {}),
      site,
    },
  };
}
