import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../error.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import type { Adapter, StepOutcome } from "../types.ts";
import type { Duration } from "../suspension/duration.ts";
import { parseDuration } from "../suspension/duration.ts";
import type { SuspendSite, SuspendableStep } from "../suspension/sites.ts";
import { SuspensionHeaders } from "../suspension/exchange-state.ts";
import type { AnswerPolicy } from "../suspension/types.ts";
import type { ResumeAuthorizer } from "../suspension/answerer.ts";

/**
 * Options for `.suspend()`.
 *
 * Notification, conditional asking, and consuming the verdict are all
 * expressible with operations the DSL already has, so none of them is an
 * option here: notify with a `.tap()` before the suspend, gate with
 * `.choice()`, consume with `.filter()` after it.
 *
 * Authorizing the ANSWERER is different, and it is here rather than on the
 * resume ingress for one reason: refusing below the store claim would burn
 * the single-use answer, so the check has to run pre-claim, and the policy
 * has to travel with the question rather than with the door.
 *
 * @template Schema - The `schema` option, whose output types `ex.suspension.result`
 */
export interface SuspendOptions<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /**
   * The declared shape of the answer slot. Optional.
   *
   * The framework has no approve/deny concept: a suspension is a durable
   * pause with one single-use answer slot of arbitrary shape, and this
   * route's own continuation interprets whatever arrives. Declaring a
   * schema buys three things: the JSON Schema rendering advertised on the
   * acknowledgment so an approver UI or a calling agent can render a form,
   * pre-claim validation of the answer (`RC5049`, so garbage cannot spend
   * the approval), and the typing of `ex.suspension.result` downstream.
   *
   * Absent, none of those apply: no ingress validation, and the result
   * types `unknown`. A click-yes consent flow stops paying schema ceremony
   * it never needed.
   */
  schema?: Schema;
  /**
   * How long the suspension stays resumable. Omit for no expiry.
   *
   * An expired suspension is not a dead end: the answer arriving late (or
   * the sweeper reaching it first) re-enters this route's error channel
   * with `RC5047`, so a route-scope `.error()` can notify the approver and
   * re-ask.
   */
  ttl?: Duration;
  /**
   * Channel this suspension is parked on, matched against the `keys` a
   * `.resume()` door declares.
   *
   * Segmentation, not addressing: the single-use token already addresses
   * exactly one record at one position, so the key's job is letting
   * different ingress routes serve different classes of approval under
   * different transport auth, and bounding what a misconfigured or
   * compromised door can answer.
   */
  key?: string;
  /**
   * The declarative floor on who may answer, persisted on the record and
   * enforced from there.
   *
   * Policy travels with the question: editing this option affects future
   * parks only, and a parked record keeps the policy its approver was
   * promised.
   */
  answer?: AnswerPolicy;
  /**
   * Predicate escape hatch for authorization the declarative floor cannot
   * express (thresholds, departments, org-specific relationships).
   *
   * Runs pre-claim, so a refusal never burns the rightful answerer's
   * single-use answer. Returning false or throwing refuses; a thrown cause
   * is logged at the boundary and never returned to the answerer.
   *
   * Unlike {@link SuspendOptions.answer} this cannot persist, so its
   * VERBATIM SOURCE is folded into the continuation hash: editing it takes
   * the `RC5048` re-ask rather than silently applying to records parked
   * under the previous one.
   */
  authorize?: ResumeAuthorizer;
}

/** Marker adapter for the suspend step; its options live on the step. */
export interface SuspendAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.suspend";
}

/**
 * Step that parks the exchange and exits the pipeline.
 *
 * It performs no effects of its own: it produces the `suspend` outcome and
 * the executor does the parking. Nothing is scheduled, no worker waits, and
 * the route stays live for every other exchange, because a parked exchange
 * lives in the suspension store rather than in this process.
 */
export class SuspendStep implements SuspendableStep {
  readonly operation = OperationType.SUSPEND;
  readonly adapter: SuspendAdapter = {
    adapterId: "routecraft.operation.suspend",
  };

  /**
   * Assigned by the build-time site resolver. A step that never got one is
   * not reachable from a built route, so there is no continuation to revive
   * and the step refuses rather than parking an exchange nothing can wake.
   */
  site?: SuspendSite;

  /**
   * The live answer schema, when one was declared. Public because the
   * resume path reads it back off the route to validate the candidate
   * answer: a Standard Schema is an object with a validate function, so it
   * cannot travel in the record.
   */
  readonly schema?: StandardSchemaV1;

  /**
   * The live answerer predicate, when one was declared. Read back off the
   * route at resume the same way the schema is, and covered by the
   * continuation hash so an edit is caught rather than silently applied.
   */
  readonly authorize?: ResumeAuthorizer;

  /** The declarative floor, persisted onto the record at park. */
  readonly answer?: AnswerPolicy;

  /** Channel this site parks on, persisted onto the record at park. */
  readonly key?: string;

  readonly #expiresInMs?: number;

  constructor(options: SuspendOptions = {}) {
    if (options.schema !== undefined) this.schema = options.schema;
    if (options.authorize !== undefined) this.authorize = options.authorize;
    if (options.answer !== undefined) this.answer = options.answer;
    if (options.key !== undefined) {
      if (typeof options.key !== "string" || options.key.trim() === "") {
        throw rcError("RC5003", undefined, {
          message:
            ".suspend({ key }) must be a non-empty string: it names the channel a .resume({ keys }) door serves.",
        });
      }
      this.key = options.key;
    }
    if (options.ttl !== undefined) {
      this.#expiresInMs = parseDuration(options.ttl, ".suspend({ ttl })");
    }
  }

  async execute(exchange: Exchange): Promise<StepOutcome> {
    if (!this.site) {
      throw rcError("RC5051", undefined, {
        message:
          "This .suspend() is not reachable from a built route, so the framework cannot work out what would run when it resumes. Build the route through craft()...build() rather than assembling a RouteDefinition by hand.",
      });
    }
    // A site with no key of its own inherits the channel of the record this
    // exchange resumed from, when it resumed from one. Two-stage approvals
    // stay on the door that served the first stage without restating it.
    const key = this.key ?? exchange.headers[SuspensionHeaders.KEY];
    return {
      kind: "suspend",
      exchange,
      request: {
        ...(this.schema !== undefined ? { schema: this.schema } : {}),
        ...(this.#expiresInMs !== undefined
          ? { expiresInMs: this.#expiresInMs }
          : {}),
        ...(this.answer !== undefined ? { answer: this.answer } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(this.authorize !== undefined ? { authorize: this.authorize } : {}),
        site: this.site,
      },
    };
  }
}
