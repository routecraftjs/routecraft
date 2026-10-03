import { rcError } from "../error.ts";
import { anySignal } from "../shared/abort.ts";
import {
  type Exchange,
  DefaultExchange,
  OperationType,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { isRestored } from "../auth/restored.ts";
import { toSignalContext } from "../types.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import {
  type ResumeAcknowledgment,
  type ResumeRequest,
  reviveDeferral,
} from "../deferral/revive.ts";
import { principalRef } from "../deferral/principal-ref.ts";
import type {
  ResumeAuthorizer,
  ResumeElevator,
} from "../deferral/authorize.ts";

/**
 * Maps the ingress exchange to the deferral it resumes.
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
   * deferral it names.
   *
   * The framework has no model of what makes a resuming principal
   * legitimate, so it does not ship one. What it guarantees is the part an
   * application cannot build from outside: this runs BEFORE the store's
   * compare-and-swap, so a "no" never spends the rightful principal's
   * single-use link, and before the record's lifecycle is disclosed, so a
   * refused caller learns nothing about it.
   *
   * Receives the live principal (whatever this route's `.authenticate()`
   * resolved, or undefined when it resolved nobody), the deferred principal
   * restored from storage, the raw submitted payload, and the record's
   * context, including the `meta` the defer site attached. Never the
   * deferred body.
   *
   * Omitted, the door is bearer: any holder of a valid token may resume.
   * That is the historical behaviour and it stays the default, so securing
   * a resume ingress is a thing you do, not a thing you inherit.
   */
  authorize?: ResumeAuthorizer;

  /**
   * Re-mints the principal the continuation runs with, so it carries more
   * authority than the exchange parked with.
   *
   * Without it a continuation always runs as the principal that parked,
   * which comes back from the store marked restored and therefore fails
   * `.authorize()` with `RC5043` by design. That is the correct default: a
   * shape read off disk is not a credential. This hook is how an application
   * says "I re-verified this identity just now, and a human lent it one more
   * scope".
   *
   * Returns a LIVE principal or throws; a throw is a refusal and is the
   * right answer whenever the world moved under the park. The framework
   * enforces three things and has no other opinion: the principal is live
   * (not restored), it is the SAME two parties the exchange parked with, and
   * the only thing that changed is `scopes`, capped by the scopes the
   * refusal that parked the exchange named. Anything else is `RC5056`,
   * non-destructive, so the record stays resumable.
   *
   * Because the principal is live, the continuation re-runs the route's
   * `.authorize()`: the lent scope has to satisfy the gate that refused it
   * or the resume fails the way the original call did. Note that a lend on
   * the ACTOR's ring is only read by a gate declaring `effective: true`, and
   * that a gate whose `predicate` reads `principal.claims` sees the claims
   * this hook minted rather than the ones the exchange parked with.
   *
   * Runs immediately after `authorize` and above the record's claim, so a
   * refusal never spends the rightful principal's single-use link.
   *
   * @example
   * ```ts
   * .resume(mapper, {
   *   authorize: ({ principal, record }) =>
   *     principal?.email === record.meta.approver,
   *   elevate: ({ deferred, payload }) => applyStepUp(deferred, parse(payload)),
   * })
   * ```
   */
  elevate?: ResumeElevator;
}

/**
 * Step that revives a deferred exchange addressed by a signed token.
 *
 * It addresses an EXCHANGE, not a route. `direct("x")` names a route and
 * enters it through its source; resume names one deferred exchange and
 * re-enters its pipeline partway down. That is why a Gmail-born exchange
 * can be continued by a WhatsApp-born resume: the original source takes no
 * part in execution two, and sources create exchanges rather than revive
 * them.
 *
 * The revived route runs to completion before this step resolves, so the
 * acknowledgment it puts in the ingress body reports how execution two
 * actually ended. That is also what makes a duplicate resume cheap: it
 * returns the cached continuation result of the first one instead of running
 * anything.
 */
export class ResumeStep<In = unknown> implements Step<ResumeAdapter> {
  readonly operation = OperationType.RESUME;
  readonly adapter: ResumeAdapter = {
    adapterId: "routecraft.operation.resume",
  };

  /** The door's own authorization policy, when it declares one. */
  readonly authorize?: ResumeAuthorizer;

  /** The door's re-mint of the parked principal, when it declares one. */
  readonly elevate?: ResumeElevator;

  constructor(
    private readonly mapper?: ResumeMapper<In>,
    options?: ResumeOptions,
  ) {
    if (options?.authorize !== undefined) {
      if (typeof options.authorize !== "function") {
        throw rcError("RC5003", undefined, {
          message:
            ".resume({ authorize }) must be a function receiving { principal, deferred, payload, record } and returning a boolean (or a promise of one).",
        });
      }
      this.authorize = options.authorize;
    }
    if (options?.elevate !== undefined) {
      if (typeof options.elevate !== "function") {
        throw rcError("RC5003", undefined, {
          message:
            ".resume({ elevate }) must be a function receiving { principal, deferred, payload, record } and returning the live Principal the continuation runs with (or a promise of one), or throwing to refuse.",
        });
      }
      this.elevate = options.elevate;
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
          "Cannot resume: this exchange has no context binding, so there is no deferral store to revive from.",
      });
    }

    const signalCtx = toSignalContext(ctx) as {
      readonly signal?: AbortSignal;
    };
    // The hook's bound is the route's intake signal (shutdown has begun) as
    // well as an enclosing .timeout(): ctx.signal is populated only by a
    // route-scope timeout, so
    // racing the hook against that alone leaves a resume route without one
    // unable to interrupt a hook that never settles, and an unsettled hook
    // holds the step, which holds drain().
    const route = getExchangeRoute(exchange);
    const hookSignal = anySignal(route?.intakeSignal, signalCtx.signal);
    // Only a principal this ingress verified live may stand as the resuming
    // party. A revived exchange carries its deferred principal back marked
    // restored, so a route that both defers and resumes would otherwise
    // hand the hook storage data under a contract that says verified live.
    const live =
      exchange.principal && !isRestored(exchange.principal)
        ? exchange.principal
        : undefined;
    const request = this.mapper
      ? await this.mapper(exchange as Exchange<In>, signalCtx)
      : fromBody(exchange);

    const acknowledgment: ResumeAcknowledgment = await reviveDeferral(
      context,
      {
        ...request,
        // The ingress route's principal is the one worth recording: it was
        // verified live here, on the route that accepted the submission,
        // unlike anything read back out of the store. An explicit
        // `resumedBy` from the mapper wins, for an ops tool resuming on
        // someone's behalf.
        ...(request.resumedBy === undefined && live
          ? { resumedBy: principalRef(live) }
          : {}),
      },
      // The door's own facts, kept OFF the mapper's request on purpose. The
      // mapper shapes a transport payload, which is exactly what an attacker
      // controls; letting it name the principal or supply the hook would let
      // the untrusted half of an ingress choose what the trusted half checks.
      {
        ...(this.authorize !== undefined ? { authorize: this.authorize } : {}),
        ...(this.elevate !== undefined ? { elevate: this.elevate } : {}),
        ...(live ? { principal: live } : {}),
        ...(hookSignal ? { signal: hookSignal } : {}),
      },
    );

    return {
      kind: "continue",
      exchange: DefaultExchange.rewrap(exchange, { body: acknowledgment }),
      metadata: {
        deferralId: acknowledgment.deferralId,
        resumedRouteId: acknowledgment.routeId,
        status: acknowledgment.status,
        outcome: acknowledgment.continuation.status,
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
