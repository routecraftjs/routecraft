import { type Adapter, type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  DefaultExchange,
  HeadersKeys,
} from "../exchange.ts";
import { type PrincipalClaims } from "../auth/authenticate.ts";
import { delegate, type DelegateOptions } from "../auth/delegate.ts";
import { rcError } from "../error.ts";

/**
 * Delegation directive returned by a {@link CallableDelegator}: the actor
 * identity plus the consent-derived scope ceiling.
 */
export interface DelegationClaims extends DelegateOptions {
  /** Identity claims of the party that will act on the subject's behalf. */
  actor: PrincipalClaims;
}

/**
 * Resolve the delegation for the current exchange. Return a directive to
 * mark an actor as acting on the current principal's behalf, or `undefined`
 * when no consent exists. What `undefined` does to the exchange is governed
 * by {@link DelegateStepOptions.otherwise}: by default the subject's direct
 * principal is stripped (the continuation runs anonymous), so an actor
 * downstream never wields an identity nobody consented to hand it.
 *
 * @template T - Body type of the exchange
 */
export type CallableDelegator<T = unknown> = (
  exchange: Exchange<T>,
) => DelegationClaims | undefined | Promise<DelegationClaims | undefined>;

/**
 * Options for the `.delegate()` operation.
 */
export interface DelegateStepOptions {
  /**
   * What happens to the exchange when the resolver returns `undefined`
   * (no consent record):
   *
   * - `"drop"` (default): strip the subject's direct principal so the
   *   exchange continues anonymous. This is the right mode when the
   *   continuation acts THROUGH someone else (an agent, a service): without
   *   consent, the actor must not inherit the caller's full direct
   *   authority, which is exactly what passing the principal through would
   *   grant. Downstream `authorize()` then refuses with RC5012 instead of
   *   silently acting with undelegated power. The strip is precise: it
   *   only removes a principal that is present, not already delegated (no
   *   `actor`), and not an autonomous agent subject
   *   (`subjectProfile: "ai_agent"`). Anonymous exchanges, delegated
   *   principals, and agent subjects pass through untouched.
   *
   * - `"keep"`: leave the exchange untouched, preserving the caller's
   *   direct principal. This is the right mode when the continuation
   *   serves the caller DIRECTLY (the delegation was an optional
   *   enhancement, not the authority boundary), so an ungranted caller
   *   should keep acting as themselves.
   */
  otherwise?: "drop" | "keep";
}

/**
 * Step that marks the exchange's principal as being exercised by an actor
 * (an agent, a service) on the subject's behalf. Mints the delegated
 * principal via `delegate()` and writes it onto
 * `headers["routecraft.auth.principal"]`. Body is unchanged.
 *
 * Requires an authentic principal on the exchange: delegation transforms an
 * existing identity, it never creates one. A resolver that finds no
 * principal to delegate should return `undefined`; returning a directive on
 * an anonymous exchange throws RC5012. When the resolver returns
 * `undefined`, the no-consent behavior follows
 * {@link DelegateStepOptions.otherwise} (default: strip the direct
 * principal, fail closed).
 */
export class DelegateStep<T = unknown> implements Step<Adapter> {
  operation: OperationType = OperationType.HEADER;
  adapter: Adapter = {};

  constructor(
    private readonly resolve: CallableDelegator<T>,
    private readonly options: DelegateStepOptions = {},
  ) {}

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const directive = await Promise.resolve(this.resolve(exchange));
    if (directive === undefined) {
      if ((this.options.otherwise ?? "drop") === "keep") {
        return { kind: "continue", exchange };
      }
      return { kind: "continue", exchange: dropUndelegated(exchange) };
    }

    const subject = exchange.principal;
    if (!subject) {
      throw rcError("RC5012", new Error("No principal to delegate"), {
        message:
          "delegate step: resolver returned a delegation directive but the exchange has no authenticated principal",
        suggestion:
          "Establish identity first (.authenticate() or a source verifier), or return undefined from the resolver when the exchange is anonymous.",
      });
    }

    const { actor, ...options } = directive;
    const next = DefaultExchange.rewrap<T>(exchange, {
      headers: {
        ...exchange.headers,
        [HeadersKeys.AUTH_PRINCIPAL]: delegate(subject, actor, options),
      },
    });
    return { kind: "continue", exchange: next };
  }
}

/**
 * Fail-closed backstop for the default `otherwise: "drop"` mode: a direct
 * principal that did NOT get delegated must not flow onward, or the
 * continuation would wield the caller's full authority precisely when
 * consent is absent. Strips the principal so the exchange continues
 * anonymous and every downstream `authorize()` refuses it (RC5012).
 *
 * The strip is deliberately narrow. Untouched pass through for:
 * - anonymous exchanges (nothing to strip),
 * - already-delegated principals (an earlier hop established consent),
 * - autonomous agent subjects (`subjectProfile: "ai_agent"`), which are
 *   minted deliberately on internal triggers and act as themselves.
 */
function dropUndelegated<T>(exchange: Exchange<T>): Exchange<T> {
  const principal = exchange.principal;
  if (!principal || principal.actor) return exchange;
  if (principal.subjectProfile === "ai_agent") return exchange;
  const headers = { ...exchange.headers };
  delete headers[HeadersKeys.AUTH_PRINCIPAL];
  return DefaultExchange.rewrap<T>(exchange, { headers });
}
