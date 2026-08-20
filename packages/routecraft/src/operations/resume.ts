import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  OperationType,
  getExchangeContext,
} from "../exchange.ts";
import { toSignalContext } from "../types.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import {
  type ResumeAcknowledgment,
  type ResumeRequest,
  reviveSuspension,
} from "../suspension/revive.ts";
import { principalRef } from "../suspension/principal-ref.ts";

/**
 * Maps the ingress exchange to the suspension it answers.
 *
 * The preferred form of `.resume()`, because the ingress transport decides
 * where the token and the answer actually live: a token in a mail subject
 * line and a verdict in the first line of the reply, a chat webhook's
 * button payload, an ops CLI's flags.
 *
 * @template T - Body type of the ingress exchange
 */
export type ResumeMapper<T = unknown> = (
  exchange: Exchange<T>,
  ctx?: { readonly signal?: AbortSignal },
) => ResumeRequest | Promise<ResumeRequest>;

/** Marker adapter for the resume step; the mapper lives on the step. */
export interface ResumeAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.resume";
}

/**
 * Options for `.resume()`.
 */
export interface ResumeOptions {
  /**
   * Channels this door serves, matched against the `key` a suspension was
   * parked on.
   *
   * Segmentation, not addressing: the token already names one record at one
   * position, so keys exist to let several classes of approval share a
   * context under different transport auth, and to bound what one
   * misconfigured or compromised ingress can answer. A door that declares
   * none serves every channel, which is the single-door default; declaring
   * any narrows it to exactly those.
   */
  keys?: readonly string[];
}

/**
 * Step that revives a parked exchange addressed by a signed token.
 *
 * It addresses an EXCHANGE, not a route. `direct("x")` names a route and
 * enters it through its source; resume names one parked exchange and
 * re-enters its pipeline partway down. That is why a Gmail-born exchange
 * can be continued by a WhatsApp-born answer: the original source takes no
 * part in execution two, and sources create exchanges rather than revive
 * them.
 *
 * The revived route runs to completion before this step resolves, so the
 * acknowledgment it puts in the ingress body reports how execution two
 * actually ended. That is also what makes a duplicate answer cheap: it
 * returns the cached terminal outcome of the first one instead of running
 * anything.
 */
export class ResumeStep<In = unknown> implements Step<ResumeAdapter> {
  readonly operation = OperationType.RESUME;
  readonly adapter: ResumeAdapter = {
    adapterId: "routecraft.operation.resume",
  };

  /**
   * Channels this door serves. Read by the revive path to refuse a record
   * parked on a channel this ingress was not pointed at, and at build time
   * to warn about keyed sites with keyless doors.
   */
  readonly keys?: readonly string[];

  constructor(
    private readonly mapper?: ResumeMapper<In>,
    options?: ResumeOptions,
  ) {
    if (options?.keys !== undefined) {
      if (
        !Array.isArray(options.keys) ||
        options.keys.length === 0 ||
        options.keys.some((key) => typeof key !== "string" || key.trim() === "")
      ) {
        throw rcError("RC5003", undefined, {
          message:
            ".resume({ keys }) must be a non-empty array of non-empty strings: it names the .suspend({ key }) channels this door serves. Omit it entirely for a door that serves every channel.",
        });
      }
      this.keys = [...options.keys];
    }
  }

  async execute(exchange: Exchange, ctx: StepContext): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    if (!context) {
      // Not RC5052: nothing is misconfigured. An exchange reaching a step
      // without a context binding is a framework invariant violation, which
      // is what the catch-all code is for.
      throw rcError("RC5001", undefined, {
        message:
          "Cannot resume: this exchange has no context binding, so there is no suspension store to revive from.",
      });
    }

    const request = this.mapper
      ? await this.mapper(
          exchange as Exchange<In>,
          toSignalContext(ctx) as { readonly signal?: AbortSignal },
        )
      : fromBody(exchange);

    const acknowledgment: ResumeAcknowledgment = await reviveSuspension(
      context,
      {
        ...request,
        // The ingress route's principal is the one worth recording: it was
        // verified live here, on the route that accepted the answer, unlike
        // anything read back out of the store. An explicit `resumedBy` from
        // the mapper wins, for an ops tool answering on someone's behalf.
        ...(request.resumedBy === undefined && exchange.principal
          ? { resumedBy: principalRef(exchange.principal) }
          : {}),
      },
      // The door's own facts, kept OFF the mapper's request on purpose. The
      // mapper is user code shaping a transport payload; letting it name the
      // answerer or widen the door's channels would let the untrusted half
      // of an ingress choose what the trusted half checks.
      {
        ...(this.keys !== undefined ? { keys: this.keys } : {}),
        ...(exchange.principal ? { answerer: exchange.principal } : {}),
      },
    );

    return {
      kind: "continue",
      exchange: DefaultExchange.rewrap(exchange, { body: acknowledgment }),
      metadata: {
        suspensionId: acknowledgment.suspensionId,
        resumedRouteId: acknowledgment.routeId,
        status: acknowledgment.status,
        outcome: acknowledgment.outcome.status,
      },
    };
  }
}

/**
 * The convention fallback for a bare `.resume()`: the body is already
 * `{ token, result }`.
 *
 * Refuses anything else rather than reviving with a token read out of a
 * shape it does not recognise, since the token is a bearer capability and a
 * wrong one is a resume against the wrong exchange.
 *
 * @internal
 */
function fromBody(exchange: Exchange): ResumeRequest {
  const body = exchange.body as { token?: unknown; result?: unknown } | null;
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.token !== "string" ||
    !("result" in body)
  ) {
    throw rcError("RC5041", undefined, {
      message:
        "Bare .resume() expects the body to already be shaped { token, result }. Map it explicitly with .resume((ex) => ({ token, result })) when the ingress carries the answer in its own shape.",
    });
  }
  return { token: body.token, result: body.result };
}
