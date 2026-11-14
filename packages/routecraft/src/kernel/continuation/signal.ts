import { BRAND, isBranded, setBrand } from "../../brand.ts";
import type { Exchange } from "../../exchange.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../../types.ts";
import type { DeferTicket } from "./sites.ts";

/**
 * What `ctx.defer()` rejects with: control flow, carrying the ticket the
 * handle minted. The kernel turns it into the `defer` outcome where the
 * step was run, so nothing above the step sees a failure.
 *
 * Branded rather than `instanceof`-checked, so it survives two copies of
 * this package in one process.
 *
 * @internal
 */
export class DeferSignal extends Error {
  override readonly name = "DeferSignal";
  readonly ticket: DeferTicket;

  constructor(ticket: DeferTicket) {
    super(
      "ctx.defer() was called and its rejection was not returned to the step's caller. " +
        "Await it, or return its promise, from the step or adapter that was handed the context.",
    );
    this.ticket = ticket;
    setBrand(this, BRAND.DeferSignal);
  }
}

/**
 * Whether a thrown value is what `ctx.defer()` rejects with. Code between
 * a deferring adapter and its step uses it to let a deferral pass through
 * its own error accounting instead of reporting it as a failure.
 */
export function isDeferSignal(value: unknown): value is DeferSignal {
  return isBranded(value, BRAND.DeferSignal);
}

/**
 * Run a step, turning a deferral it raised through `ctx.defer()` into the
 * `defer` outcome.
 *
 * Every place the kernel runs a step goes through here, a step-scope
 * wrapper running its inner step included. That is what keeps a wrapper
 * honest: a `.retry()` that saw the rejection would run the step again and
 * charge the work twice, so by the time a wrapper sees anything the
 * deferral is an outcome it passes through.
 *
 * @internal
 */
export async function executeStep(
  step: Step<Adapter>,
  exchange: Exchange,
  ctx: StepContext,
): Promise<StepOutcome> {
  try {
    return await step.execute(exchange, ctx);
  } catch (err) {
    if (isDeferSignal(err)) {
      return { kind: "defer", exchange, request: err.ticket };
    }
    throw err;
  }
}
