import { authenticate, type PrincipalClaims } from "../../auth/authenticate.ts";
import { isAuthentic, markAuthentic } from "../../auth/authentic.ts";
import { isRestored, markRestored } from "../../auth/restored.ts";
import type { Principal } from "../../auth/types.ts";
import type { CraftContext } from "../../context.ts";
import {
  getExchangeContext,
  principalOf,
  type Exchange,
} from "../../exchange.ts";
import { registerDefaultPlugin } from "../../kernel/defaults.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { port } from "../../kernel/port.ts";

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
  /** Whether this authority established the principal: minted or branded. */
  isAuthentic(principal: unknown): principal is Principal;
  /**
   * A principal read back from durable storage: a recorded shape with no
   * live credential behind it, which no gate trusts as authentic.
   */
  restore(record: Principal): Principal;
  /** Whether a principal is a {@link Authority.restore restored} record. */
  isRestored(principal: unknown): boolean;
  /** The principal an exchange acts for, when one is resolved. */
  read(exchange: Pick<Exchange, "headers">): Principal | undefined;
}

/** The principals: who an exchange acts for and whether it is trusted. */
export const AUTHORITY = port<Authority>("routecraft.principals@1");

/** The framework's authority: what fills `AUTHORITY` unless replaced. */
export const defaultAuthority: Authority = {
  mint: authenticate,
  brand: markAuthentic,
  isAuthentic,
  restore: markRestored,
  isRestored,
  read: principalOf,
};

/**
 * The authority of the application an exchange or context belongs to.
 *
 * Falls back to the default only where there is no application at all (a
 * plain exchange in a unit test), where nothing could have replaced it.
 */
export function authorityOf(
  from: Exchange | Pick<CraftContext, "lookup"> | undefined,
): Authority {
  const context =
    from !== undefined && "lookup" in from
      ? from
      : from !== undefined
        ? getExchangeContext(from)
        : undefined;
  return context?.lookup(AUTHORITY) ?? defaultAuthority;
}

/** The plugin that provides {@link AUTHORITY}, installed by default. */
export function principalsPlugin() {
  return definePlugin({
    id: "routecraft.principals",
    provides: [AUTHORITY],
    bind(c) {
      c.provide(AUTHORITY, defaultAuthority);
    },
  });
}

registerDefaultPlugin("routecraft.principals", principalsPlugin);
