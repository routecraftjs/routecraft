/**
 * Consulting a point's registered handlers, in order.
 *
 * Every handler point shares a walk (registration order, a throw reported
 * without taking the chain down, a bound on each call) and differs only in
 * what an answer MEANS. Those two are separated here deliberately: the walk
 * is the registry's, and the meaning belongs to the point.
 *
 * The distinction that forces the separation is refusal against decoration.
 * At `error` there is one recovery and one winner, so the first answer ends
 * the chain. At the other points the non-refusing answer is a decoration
 * (headers, a replacement body), and those must accumulate: under one rule
 * two redactors at `exit` could never both run, which breaks for the second
 * developer to add one rather than the first.
 */

import { HOOK_ABORTED, settleOrAbort } from "../shared/abort.ts";

/**
 * What one handler's answer means at its point.
 *
 * `abandon` is not `settle` with nothing: it says no handler at this point
 * will decide, so the chain ends where it is and the exchange carries on as
 * if the point had been empty. `error`'s `recovery.rethrow()` is the shipped
 * case, where a handler declines on behalf of the whole chain.
 */
export type HandlerVerdict<Settlement, Decoration> =
  | { readonly kind: "pass" }
  | { readonly kind: "abandon" }
  | { readonly kind: "settle"; readonly settlement: Settlement }
  | { readonly kind: "decorate"; readonly decoration: Decoration };

/**
 * What one point does with its handlers, beyond calling them in order.
 *
 * @typeParam H - The point's handler type
 * @typeParam Settlement - What a refusal resolves the exchange to
 * @typeParam Decoration - What a non-refusing answer contributes
 */
export interface ConsultationPolicy<H, Settlement, Decoration> {
  /**
   * Call one handler. Whatever it returns is handed to {@link read}.
   *
   * Takes what earlier handlers decorated, so a point whose handlers see the
   * accumulation (rather than the original exchange) can pass it on.
   */
  readonly invoke: (
    handler: H,
    carried: Decoration | undefined,
  ) => unknown | Promise<unknown>;
  /**
   * Read one answer, and apply it where applying can fail.
   *
   * Applying belongs here rather than after the walk because reaching a
   * decision and acting on it fail the same way: a park is refused at a
   * position it cannot be revived from, or its store write fails. A throw
   * from either is reported as that handler's and the chain continues,
   * which is the one place it can be caught while the point still has
   * another handler to ask.
   */
  readonly read: (
    answer: unknown,
    carried: Decoration | undefined,
  ) =>
    | HandlerVerdict<Settlement, Decoration>
    | Promise<HandlerVerdict<Settlement, Decoration>>;
  /**
   * Fold a decoration onto what earlier handlers produced.
   *
   * Absent means the last decoration wins, which is right only for a point
   * that cannot accumulate. A point whose answers are decorations supplies
   * this, or its second handler silently erases its first.
   */
  readonly merge?: (
    carried: Decoration | undefined,
    decoration: Decoration,
  ) => Decoration;
  /** Called before each handler, for the point's own invoked event. */
  readonly announce?: (index: number) => void;
  /**
   * Report a handler that threw, or one the signal cut short.
   *
   * `aborted` separates the two for the operator: a handler that broke and
   * one that never settled mean different things even where they produce
   * the same code on the wire.
   */
  readonly report: (thrown: unknown, index: number, aborted: boolean) => void;
  /**
   * What may cut a handler short.
   *
   * Every point is bounded by the route's own signal: an unsettled handler
   * otherwise holds the step, and the step holds `drain()`.
   */
  readonly signal?: AbortSignal;
}

/** What a walk with nothing to say returns, shared so an empty point allocates nothing. */
const NOTHING: ConsultationResult<never, never> = Object.freeze({});

/** What a point's chain produced: at most one of the two. */
export interface ConsultationResult<Settlement, Decoration> {
  /** A handler refused or decided, and no later handler ran. */
  readonly settlement?: Settlement;
  /** What the decorating handlers accumulated, if any decorated. */
  readonly carried?: Decoration;
}

/**
 * Consult a point's handlers in registration order.
 *
 * A refusal ends the chain, a decoration feeds the next handler, `undefined`
 * passes, and a handler that throws is reported while the chain continues:
 * a chain whose first member could take the whole point down with it would
 * be worse than no chain.
 *
 * An abort is different from a throw and ends the chain, because the signal
 * that fired belongs to the route rather than to the handler: asking the
 * next handler would be asking it to work on an exchange nobody is waiting
 * for any more.
 *
 * @param handlers - The point's handlers, already narrowed by their selectors
 * @param policy - What this point does with an answer
 * @returns The settlement a handler reached, or the accumulated decoration
 */
export async function consultHandlers<H, Settlement, Decoration>(
  handlers: readonly H[],
  policy: ConsultationPolicy<H, Settlement, Decoration>,
): Promise<ConsultationResult<Settlement, Decoration>> {
  // A point nobody registered at costs one length check per exchange.
  if (handlers.length === 0)
    return NOTHING as ConsultationResult<Settlement, Decoration>;

  let carried: Decoration | undefined;
  for (const [index, handler] of handlers.entries()) {
    policy.announce?.(index);
    let verdict: HandlerVerdict<Settlement, Decoration>;
    try {
      const answer = await settleOrAbort(
        () => policy.invoke(handler, carried),
        policy.signal,
      );
      verdict = await policy.read(answer, carried);
    } catch (thrown) {
      const aborted = thrown === HOOK_ABORTED;
      policy.report(thrown, index, aborted);
      if (aborted) return NOTHING as ConsultationResult<Settlement, Decoration>;
      continue;
    }
    switch (verdict.kind) {
      case "pass":
        continue;
      case "abandon":
        return NOTHING as ConsultationResult<Settlement, Decoration>;
      case "settle":
        return { settlement: verdict.settlement };
      case "decorate":
        carried = policy.merge
          ? policy.merge(carried, verdict.decoration)
          : verdict.decoration;
        continue;
    }
  }
  return carried === undefined
    ? (NOTHING as ConsultationResult<Settlement, Decoration>)
    : { carried };
}
