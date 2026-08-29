import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../error.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import type { Adapter, StepOutcome } from "../types.ts";
import type { Duration } from "../shared/duration.ts";
import { parseDuration } from "../shared/duration.ts";
import type { SuspendSite, SuspendableStep } from "../suspension/sites.ts";

/**
 * Options for `.suspend()`.
 *
 * Notification, conditional asking, and consuming the verdict are all
 * expressible with operations the DSL already has, so none of them is an
 * option here: notify with a `.tap()` before the suspend, gate with
 * `.choice()`, consume with `.filter()` after it.
 *
 * Who may RESUME is not an option here either, and deliberately so: the
 * framework has no model of what makes a resuming principal legitimate.
 * `meta` carries whatever the application's own policy needs onto the
 * record, and `.resume({ authorize })` is where that policy runs.
 *
 * @template Schema - The `schema` option, whose output types `ex.suspension.result`
 */
export interface SuspendOptions<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /**
   * The declared shape of the resume payload. Optional.
   *
   * The framework has no approve/deny concept: a suspension is a durable
   * pause with one single-use payload slot of arbitrary shape, and this
   * route's own continuation interprets whatever arrives. Declaring a
   * schema buys three things: the JSON Schema rendering advertised on the
   * acknowledgment so an approval UI or a calling agent can render a form,
   * pre-claim validation of the payload (`RC5049`, so garbage cannot spend
   * the link), and the typing of `ex.suspension.result` downstream.
   *
   * Absent, none of those apply: no ingress validation, and the result
   * types `unknown`. A click-yes consent flow stops paying schema ceremony
   * it never needed.
   */
  schema?: Schema;
  /**
   * How long the suspension stays resumable. Omit for no expiry.
   *
   * An expired suspension is not a dead end: a resume arriving late (or the
   * sweeper reaching it first) re-enters this route's error channel with
   * `RC5047`, so a route-scope `.error()` can notify the recipient and
   * re-ask.
   */
  ttl?: Duration;
  /**
   * Anything the resuming route needs to decide who may resume, or that an
   * operator needs to read off the record.
   *
   * Plain JSON, persisted verbatim, and never interpreted by the framework:
   * how approvals work is the application's design. A parker that snapshots
   * its policy here gets "policy travels with the park" for free, because
   * the record is what `.resume({ authorize })` reads and editing this site
   * cannot reach records already parked.
   */
  meta?: unknown;
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
   * The live resume-payload schema, when one was declared. Public because
   * the resume path reads it back off the route to validate the submitted
   * payload: a Standard Schema is an object with a validate function, so it
   * cannot travel in the record.
   */
  readonly schema?: StandardSchemaV1;

  /** Policy inputs the parker attached, persisted verbatim on the record. */
  readonly meta?: unknown;

  readonly #expiresInMs?: number;

  constructor(options: SuspendOptions = {}) {
    if (options.schema !== undefined) this.schema = options.schema;
    if (options.meta !== undefined) this.meta = options.meta;
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
        ...(this.schema !== undefined ? { schema: this.schema } : {}),
        ...(this.#expiresInMs !== undefined
          ? { expiresInMs: this.#expiresInMs }
          : {}),
        ...(this.meta !== undefined ? { meta: this.meta } : {}),
        site: this.site,
      },
    };
  }
}
