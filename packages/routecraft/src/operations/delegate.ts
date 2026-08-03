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
 * to leave the exchange untouched (no delegation occurs; a missing consent
 * record typically resolves to `undefined` so the actor never acquires the
 * subject's identity).
 *
 * @template T - Body type of the exchange
 */
export type CallableDelegator<T = unknown> = (
  exchange: Exchange<T>,
) => DelegationClaims | undefined | Promise<DelegationClaims | undefined>;

/**
 * Step that marks the exchange's principal as being exercised by an actor
 * (an agent, a service) on the subject's behalf. Mints the delegated
 * principal via `delegate()` and writes it onto
 * `headers["routecraft.auth.principal"]`. Body is unchanged.
 *
 * Requires an authentic principal on the exchange: delegation transforms an
 * existing identity, it never creates one. A resolver that finds no
 * principal to delegate should return `undefined`; returning a directive on
 * an anonymous exchange throws RC5012.
 */
export class DelegateStep<T = unknown> implements Step<Adapter> {
  operation: OperationType = OperationType.HEADER;
  adapter: Adapter = {};

  constructor(private readonly resolve: CallableDelegator<T>) {}

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const directive = await Promise.resolve(this.resolve(exchange));
    if (directive === undefined) return { kind: "continue", exchange };

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
