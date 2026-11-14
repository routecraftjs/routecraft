import { IDENTITY, type Identity } from "../../kernel/continuation/identity.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../../error.ts";
import { DEFERS } from "../../dsl-symbol.ts";
import { type Exchange, OperationType } from "../../exchange.ts";
import type { Adapter, StepContext, StepOutcome } from "../../types.ts";
import type { Duration } from "../../shared/duration.ts";
import { parseDuration } from "../../shared/duration.ts";
import type {
  DeferDeclaration,
  DeferringStep,
} from "../../kernel/continuation/sites.ts";

/**
 * Options for `.defer()`.
 *
 * Notification, conditional asking, and consuming the verdict are all
 * expressible with operations the DSL already has, so none of them is an
 * option here: notify with a `.tap()` before the defer, gate with
 * `.choice()`, consume with `.filter()` after it.
 *
 * Who may RESUME is not an option here either, and deliberately so: the
 * framework has no model of what makes a resuming principal legitimate.
 * `meta` carries whatever the application's own policy needs onto the
 * record, and `.resume({ authorize })` is where that policy runs.
 *
 * @template Schema - The `input` option, whose output types `ex.deferral.input`
 */
export interface DeferOptions<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /**
   * The declared shape of the resume payload. Optional.
   *
   * The framework has no approve/deny concept: a deferral is a durable
   * pause with one single-use payload slot of arbitrary shape, and this
   * route's own continuation interprets whatever arrives. Declaring a
   * schema buys three things: the JSON Schema rendering advertised on the
   * acknowledgment so an approval UI or a calling agent can render a form,
   * pre-claim validation of the payload (`RC5049`, so garbage cannot spend
   * the link), and the typing of `ex.deferral.input` downstream.
   *
   * Absent, none of those apply: no ingress validation, and the result
   * types `unknown`. A click-yes consent flow stops paying schema ceremony
   * it never needed.
   */
  input?: Schema;
  /**
   * How long the deferral stays resumable. Omit for no expiry.
   *
   * An expired deferral is not a dead end: a resume arriving late (or the
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
   * how approvals work is the application's design. A defer site that snapshots
   * its policy here gets "policy travels with the deferral" for free, because
   * the record is what `.resume({ authorize })` reads and editing this site
   * cannot reach records already deferred.
   */
  meta?: unknown;
}

/** Marker adapter for the defer step; its options live on the step. */
export interface DeferAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.defer";
}

/**
 * Step that defers the exchange and exits the pipeline.
 *
 * It declares a `"next-step"` site and asks the kernel to defer: nothing
 * is scheduled, no worker waits, and the route stays live for every other
 * exchange, because a deferred exchange lives in the deferral store rather
 * than in this process.
 */
export class DeferStep implements DeferringStep {
  readonly operation = OperationType.DEFER;
  readonly adapter: DeferAdapter = {
    adapterId: "routecraft.operation.defer",
  };

  readonly #input?: StandardSchemaV1;
  readonly #meta?: unknown;
  readonly #ttl?: Duration;

  constructor(options: DeferOptions = {}) {
    if (options.input !== undefined) this.#input = options.input;
    if (options.meta !== undefined) this.#meta = options.meta;
    if (options.ttl !== undefined) {
      // Parsed here so a bad duration fails the build, not the first exchange.
      parseDuration(options.ttl, ".defer({ ttl })");
      this.#ttl = options.ttl;
    }
  }

  [DEFERS](): DeferDeclaration {
    return {
      revival: "next-step",
      ...(this.#input !== undefined ? { input: this.#input } : {}),
    };
  }

  /** @internal */
  [IDENTITY](): Identity {
    return {
      kind: "routecraft.defer",
      options: {
        schema: this.#input,
        meta: this.#meta,
        ttl:
          this.#ttl !== undefined
            ? parseDuration(this.#ttl, ".defer({ ttl })")
            : undefined,
      },
    };
  }

  async execute(_exchange: Exchange, ctx?: StepContext): Promise<StepOutcome> {
    if (!ctx?.defer) {
      throw rcError("RC5051", undefined, {
        message:
          "This .defer() is not reachable from a built route, so the framework cannot work out what would run when it resumes. Build the route through craft()...build() rather than assembling a RouteDefinition by hand.",
      });
    }
    return ctx.defer({
      ...(this.#ttl !== undefined ? { ttl: this.#ttl } : {}),
      ...(this.#meta !== undefined ? { meta: this.#meta } : {}),
    });
  }
}
