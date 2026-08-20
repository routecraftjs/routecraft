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
import type { ResumeAuthorizer } from "../suspension/authorize.ts";

/**
 * Maps the ingress exchange to the suspension it resumes.
 *
 * The preferred form of `.resume()`, because the ingress transport decides
 * where the token and the payload actually live: a token in a mail subject
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
   * Decides whether the principal presenting this token may resume the
   * suspension it names.
   *
   * The framework has no model of what makes a resuming principal
   * legitimate, so it does not ship one. What it guarantees is the part an
   * application cannot build from outside: this runs BEFORE the store's
   * compare-and-swap, so a "no" never spends the rightful principal's
   * single-use link, and before the record's lifecycle is disclosed, so a
   * refused caller learns nothing about it.
   *
   * Receives the live principal (whatever this route's `.authenticate()`
   * resolved, or undefined when it resolved nobody), the parked principal
   * restored from storage, the raw submitted payload, and the record's
   * context, including the `meta` the suspend site attached. Never the
   * parked body.
   *
   * Omitted, the door is bearer: any holder of a valid token may resume.
   * That is the historical behaviour and it stays the default, so securing
   * a resume ingress is a thing you do, not a thing you inherit.
   */
  authorize?: ResumeAuthorizer;
}

/**
 * Step that revives a parked exchange addressed by a signed token.
 *
 * It addresses an EXCHANGE, not a route. `direct("x")` names a route and
 * enters it through its source; resume names one parked exchange and
 * re-enters its pipeline partway down. That is why a Gmail-born exchange
 * can be continued by a WhatsApp-born resume: the original source takes no
 * part in execution two, and sources create exchanges rather than revive
 * them.
 *
 * The revived route runs to completion before this step resolves, so the
 * acknowledgment it puts in the ingress body reports how execution two
 * actually ended. That is also what makes a duplicate resume cheap: it
 * returns the cached terminal outcome of the first one instead of running
 * anything.
 */
export class ResumeStep<In = unknown> implements Step<ResumeAdapter> {
  readonly operation = OperationType.RESUME;
  readonly adapter: ResumeAdapter = {
    adapterId: "routecraft.operation.resume",
  };

  /** The door's own authorization policy, when it declares one. */
  readonly authorize?: ResumeAuthorizer;

  constructor(
    private readonly mapper?: ResumeMapper<In>,
    options?: ResumeOptions,
  ) {
    if (options?.authorize !== undefined) {
      if (typeof options.authorize !== "function") {
        throw rcError("RC5003", undefined, {
          message:
            ".resume({ authorize }) must be a function receiving { principal, parked, payload, record } and returning a boolean (or a promise of one).",
        });
      }
      this.authorize = options.authorize;
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

    const signalCtx = toSignalContext(ctx) as {
      readonly signal?: AbortSignal;
    };
    const request = this.mapper
      ? await this.mapper(exchange as Exchange<In>, signalCtx)
      : fromBody(exchange);

    const acknowledgment: ResumeAcknowledgment = await reviveSuspension(
      context,
      {
        ...request,
        // The ingress route's principal is the one worth recording: it was
        // verified live here, on the route that accepted the submission,
        // unlike anything read back out of the store. An explicit
        // `resumedBy` from the mapper wins, for an ops tool resuming on
        // someone's behalf.
        ...(request.resumedBy === undefined && exchange.principal
          ? { resumedBy: principalRef(exchange.principal) }
          : {}),
      },
      // The door's own facts, kept OFF the mapper's request on purpose. The
      // mapper shapes a transport payload, which is exactly what an attacker
      // controls; letting it name the principal or supply the hook would let
      // the untrusted half of an ingress choose what the trusted half checks.
      {
        ...(this.authorize !== undefined ? { authorize: this.authorize } : {}),
        ...(exchange.principal ? { principal: exchange.principal } : {}),
        ...(signalCtx.signal ? { signal: signalCtx.signal } : {}),
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
        "Bare .resume() expects the body to already be shaped { token, result }. Map it explicitly with .resume((ex) => ({ token, result })) when the ingress carries the payload in its own shape.",
    });
  }
  return { token: body.token, result: body.result };
}
