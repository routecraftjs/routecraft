import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  OperationType,
  DefaultExchange,
  HeadersKeys,
} from "../exchange.ts";
import { authenticate, type PrincipalClaims } from "../auth/authenticate.ts";

/**
 * Resolve identity claims for the current exchange. Return claims to mint and
 * attach an authenticated principal, or `undefined` to leave the exchange as
 * it is (the caller stays anonymous, or keeps an already-attached identity).
 *
 * @experimental
 * @template T - Body type of the exchange
 */
export type CallableAuthenticator<T = unknown> = (
  exchange: Exchange<T>,
) => PrincipalClaims | undefined | Promise<PrincipalClaims | undefined>;

/**
 * Step that establishes the authenticated principal for the exchange. Mints a
 * branded principal from the resolver's claims (via `authenticate()`) and
 * writes it onto `headers["routecraft.auth.principal"]`. Body is unchanged.
 *
 * When the resolver returns `undefined` the exchange passes through untouched,
 * so a source that cannot identify a given caller simply leaves it anonymous.
 */
export class AuthenticateStep<T = unknown> implements Step<Adapter> {
  operation: OperationType = OperationType.HEADER;
  adapter: Adapter = {};

  constructor(private readonly resolve: CallableAuthenticator<T>) {}

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const claims = await Promise.resolve(this.resolve(exchange));
    const next =
      claims === undefined
        ? exchange
        : DefaultExchange.rewrap<T>(exchange, {
            headers: {
              ...exchange.headers,
              [HeadersKeys.AUTH_PRINCIPAL]: authenticate(claims),
            },
          });
    queue.push({ exchange: next, steps: remainingSteps });
  }
}
