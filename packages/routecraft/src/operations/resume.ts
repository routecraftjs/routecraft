import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  OperationType,
  getExchangeContext,
} from "../exchange.ts";
import { toSignalContext } from "../types.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import type { Principal } from "../auth/types.ts";
import {
  type ResumeAcknowledgment,
  type ResumeRequest,
  reviveSuspension,
} from "../suspension/revive.ts";
import type { PrincipalRef } from "../suspension/types.ts";

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

  constructor(private readonly mapper?: ResumeMapper<In>) {}

  async execute(exchange: Exchange, ctx: StepContext): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    if (!context) {
      throw rcError("RC5052", undefined, {
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

/**
 * Reduce a live principal to the audit reference the store records.
 *
 * A subset, not the principal itself: a full principal carries claims,
 * scopes and a delegation chain that would be resurrected as data with no
 * verification behind it. What the record answers is "who authorized this",
 * which is what a receipt is for.
 *
 * @internal
 */
function principalRef(principal: Principal): PrincipalRef {
  return {
    subject: principal.subject,
    ...(principal.issuer !== undefined ? { issuer: principal.issuer } : {}),
    ...(principal.clientId !== undefined
      ? { clientId: principal.clientId }
      : {}),
    ...(principal.actor?.subject !== undefined
      ? { actorSubject: principal.actor.subject }
      : {}),
  };
}
