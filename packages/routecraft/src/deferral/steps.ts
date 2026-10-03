import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Adapter, Step } from "../types.ts";
import type { DeferralAffordance } from "./exchange-state.ts";
import type { ResumeAcknowledgment } from "./revive.ts";
import { DeferStep, type DeferOptions } from "../operations/defer.ts";
import {
  ResumeStep,
  type ResumeMapper,
  type ResumeOptions,
} from "../operations/resume.ts";
import type {
  BuilderState,
  ExchangeOf,
  Retyped,
  SetBody,
  SetDeferral,
} from "../step-builder-base.ts";

/**
 * The deferral plugin's route methods. Their types are declared through
 * `StepMethods` below, because `.defer<Schema>()` is generic at the call.
 */
export const deferralSteps = {
  defer: (options?: DeferOptions): Step<Adapter> =>
    new DeferStep(options ?? {}),
  resume: (
    mapper?: ResumeMapper | ResumeOptions,
    options?: ResumeOptions,
  ): Step<Adapter> =>
    typeof mapper === "function"
      ? new ResumeStep(mapper, options)
      : // `.resume({ authorize })` puts the options first; `.resume(undefined,
        // { authorize })` is the same door written the long way, and both
        // have to reach the step or a declared hook is silently dropped.
        new ResumeStep(undefined, mapper ?? options),
};

declare module "@routecraft/routecraft" {
  interface FacetTypes<S extends BuilderState> {
    /**
     * Durable-deferral view of this exchange: the id and signed token it
     * would defer as, and after a resume the payload that revived it.
     * Readable before the `.defer()` runs, which is what lets a notification
     * step earlier in the pipeline send a working resume link. `result` is
     * typed by the last `.defer({ schema })`.
     */
    deferral: DeferralAffordance<S["deferral"]>;
  }

  interface StepMethods<S extends BuilderState, This> {
    deferral: {
      /**
       * Defer the exchange durably and exit the pipeline, to be resumed later
       * at the next step.
       *
       * This run ends here and replies immediately with the `Deferred`
       * acknowledgment, because a durable defer cannot hold a caller: the
       * resume payload arrives in hours or days and the process will be
       * restarted first. Nothing is scheduled, no worker waits, and the route
       * stays live for every other exchange. The route's real output flows to
       * its destinations on execution two, when `.resume()` revives the
       * exchange with the payload.
       *
       * The body is unchanged across the deferral, so a branch that defers
       * rejoins the main flow with the contract it left on. The payload
       * arrives beside it, on `ex.deferral.result`, typed by `schema`.
       *
       * @param options - `schema` (what a valid resume payload looks like), a
       *   `ttl` after which the deferral stops being resumable, and `meta`:
       *   anything the resuming route's `.resume({ authorize })` hook needs to
       *   decide who may resume
       * @example
       * ```ts
       * craft()
       *   .id("payout")
       *   .input({ body: PayoutRequest })
       *   .from(http({ path: "/payouts", method: "POST" }))
       *   .choice(
       *     when((ex) => ex.body.amountCents >= 50_000, (b) =>
       *       b
       *         .tap(direct("notify-approver"))
       *         .defer({ schema: Approval, ttl: "72h" })
       *         .filter((ex) =>
       *           ex.deferral.result.approved
       *             ? true
       *             : { reason: `rejected by ${ex.deferral.resumedBy?.subject}` },
       *         ),
       *     ),
       *   )
       *   .to(payouts())
       * ```
       */
      defer<Schema extends StandardSchemaV1>(
        options?: DeferOptions<Schema>,
      ): Retyped<This, SetDeferral<S, StandardSchemaV1.InferOutput<Schema>>>;

      /**
       * Revive a deferred exchange and run its continuation.
       *
       * Addresses an EXCHANGE by signed token, not a route by name: any route
       * ending in `.resume()` is a resume ingress, whether it is fed by an
       * HTTP webhook, a mail-reply parser, or an ops CLI. The original source
       * takes no part in execution two, which is what lets a mail-born
       * exchange be continued by a chat-born resume.
       *
       * The mapping function owns SHAPE (find the token, build the payload);
       * validation against the deferring step's `schema` happens at revival,
       * because only the deferral knows that schema. The bare form expects
       * the body to already be `{ token, result }`.
       *
       * Authorizing the resuming principal belongs on this route, through the
       * `authorize` option: the token proves the deployment minted it, not
       * that its holder may resume. The hook runs before the store's claim
       * and before the record's lifecycle is disclosed, so a refusal costs
       * the rightful principal nothing and tells a refused caller nothing.
       * Whoever this route authenticated is recorded as `resumedBy`. A door
       * exposed publicly wants a `.throttle()` in front of it.
       *
       * The revived route runs to completion before this step continues, so
       * the acknowledgment placed in the body reports how execution two
       * ended, and the ingress route can reply on the caller's own channel.
       * A duplicate resume returns the first one's cached continuation result
       * without re-running anything.
       *
       * @param map - Maps the ingress exchange to `{ token, result }`
       * @param options - `authorize`, deciding who may resume, and `elevate`,
       *   lending scope to the resumed run. Omitted, the door is bearer: any
       *   holder of a valid token may resume.
       * @example
       * ```ts
       * craft()
       *   .id("approval-replies")
       *   .from(mail("INBOX"))
       *   .authenticate(mailPrincipal)
       *   .resume((ex) => ({
       *     token: tokenFrom(ex.headers["routecraft.mail.subject"]),
       *     result: { approved: /^yes/i.test(ex.body.text ?? "") },
       *   }))
       *   .to(log())
       * ```
       */
      resume(
        map?: (
          exchange: ExchangeOf<S>,
          ctx?: { readonly signal?: AbortSignal },
        ) => ReturnType<ResumeMapper<S["body"]>>,
        options?: ResumeOptions,
      ): Retyped<This, SetBody<S, ResumeAcknowledgment>>;
      resume(
        options: ResumeOptions,
      ): Retyped<This, SetBody<S, ResumeAcknowledgment>>;
    };
  }
}
