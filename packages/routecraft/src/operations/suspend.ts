import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../error.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import type { Adapter, StepOutcome } from "../types.ts";
import type { Duration } from "../suspension/duration.ts";
import { parseDuration } from "../suspension/duration.ts";
import type { SuspendSite, SuspendableStep } from "../suspension/sites.ts";

/**
 * Options for `.suspend()`.
 *
 * Deliberately two fields. Everything a suspend "obviously" wants
 * (notifying the approver, asking only sometimes, handling a rejection,
 * authorizing the answerer) is expressible with operations the DSL already
 * has, so none of it is an option here: notify with a `.tap()` before the
 * suspend, gate with `.choice()`, consume the verdict with `.filter()`
 * after it, and authorize on the resume ingress route.
 *
 * @template Schema - The `expect` schema, whose output types `ex.suspension.result`
 */
export interface SuspendOptions<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /**
   * What a valid answer looks like. Types `ex.suspension.result` for every
   * step after the suspend, the way `.input()` types the body, and is what
   * the candidate result is validated against at resume time.
   */
  expect: Schema;
  /**
   * How long the suspension stays resumable. Omit for no expiry.
   *
   * An expired suspension is not a dead end: the answer arriving late (or
   * the sweeper reaching it first) re-enters this route's error channel
   * with `RC5047`, so a route-scope `.error()` can notify the approver and
   * re-ask.
   */
  ttl?: Duration;
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
   * The live `expect` schema. Public because the resume path reads it back
   * off the route to validate the candidate answer: a Standard Schema is an
   * object with a validate function, so it cannot travel in the record.
   */
  readonly expect: StandardSchemaV1;

  readonly #expiresInMs?: number;

  constructor(options: SuspendOptions) {
    if (!options?.expect) {
      throw rcError("RC5003", undefined, {
        message:
          ".suspend() requires an `expect` schema: it is what the eventual answer is validated against, and what types ex.suspension.result downstream.",
      });
    }
    this.expect = options.expect;
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
    return {
      kind: "suspend",
      exchange,
      request: {
        expect: this.expect,
        ...(this.#expiresInMs !== undefined
          ? { expiresInMs: this.#expiresInMs }
          : {}),
        site: this.site,
      },
    };
  }
}
