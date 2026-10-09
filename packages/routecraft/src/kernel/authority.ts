import type { PrincipalClaims } from "../principal.ts";
import { isExchange } from "../brand.ts";
import { getExchangeContext, type Exchange } from "../exchange.ts";
import type { Principal } from "../principal.ts";
import { rcError } from "../error.ts";
import { port, type PortLookup } from "./port.ts";

/**
 * Who an exchange acts for, and how much to trust it. What the
 * `AUTHORITY` port provides.
 *
 * Every mint and every trust check in the framework goes through one
 * authority, so a replacement decides both sides: a principal it brands is
 * one it recognises as authentic, and nothing else is.
 */
export interface Authority {
  /** Mint a principal from claims the caller verified itself. */
  mint(claims: PrincipalClaims): Principal;
  /**
   * Mark a principal a source verified (a JWT, an API key) as authentic.
   * Returns the trusted copy; never assume the argument was branded in place.
   */
  brand<P extends Principal>(principal: P): P;
  /**
   * Whether this authority established the principal: minted or branded.
   * Never true for a {@link Authority.restore restored} record: `keep()`
   * and `delegate()` trust on this check alone, so an authority that
   * restores by branding in place would let a stored identity act as a
   * live one.
   */
  isAuthentic(principal: unknown): principal is Principal;
  /**
   * A principal read back from durable storage: a recorded shape with no
   * live credential behind it, which no gate trusts as authentic. Returns a
   * new object, disjoint from every authentic principal.
   */
  restore(record: Principal): Principal;
  /** Whether a principal is a {@link Authority.restore restored} record. */
  isRestored(principal: unknown): boolean;
  /** The principal an exchange acts for, when one is resolved. */
  read(exchange: Pick<Exchange, "headers">): Principal | undefined;
}

/** The principals: who an exchange acts for and whether it is trusted. */
export const AUTHORITY = port<Authority>("routecraft.principals@1");

let fallback: Authority | undefined;

/**
 * The authority used where there is no application at all (a plain
 * exchange in a unit test), set by the principals plugin's module when the
 * package loads. Module-local: a second copy of the package keeps its own,
 * so its principals are never trusted by the first copy's gates.
 *
 * @internal
 */
export function setFallbackAuthority(authority: Authority): void {
  fallback = authority;
}

/**
 * The authority of the application an exchange or context belongs to.
 *
 * Falls back to the default only where there is no application at all: a
 * bare exchange, or no argument. An application whose plugins are not yet
 * installed, or none of whose plugins provides the port, is `RC1104` rather
 * than the default, so a replaced authority is never silently stood in for.
 *
 * @throws RC1104 when an application is present and provides no authority
 */
export function authorityOf(
  from: Exchange | PortLookup | undefined,
): Authority {
  // By the exchange brand, never by a `lookup` property: a facet of that
  // name would sit on every exchange's prototype. Anything else is the
  // lookup itself, a plugin's context included; a hand-built exchange-like
  // object that is neither has no application.
  const context =
    from === undefined
      ? undefined
      : isExchange(from)
        ? getExchangeContext(from as Exchange)
        : typeof (from as PortLookup).lookup === "function"
          ? (from as PortLookup)
          : undefined;
  if (context === undefined) {
    if (fallback === undefined) throw noAuthority();
    return fallback;
  }
  const found = context.lookup(AUTHORITY);
  if (found === undefined) throw noAuthority();
  return found;
}

function noAuthority(): Error {
  return rcError("RC1104", undefined, {
    message: `No plugin provides "${AUTHORITY.name}", or it was asked for before the application installed its plugins. The default routecraft.principals plugin provides it unless a plugin with that id replaced it without providing a value.`,
  });
}
