import { authorize } from "../../auth/authorize.ts";
import type { Principal } from "../../principal.ts";
import { principalOf, type Exchange } from "../../exchange.ts";
import { step, type Body } from "../../kernel/steps.ts";
import {
  AuthenticateStep,
  type CallableAuthenticator,
} from "../../operations/authenticate.ts";
import {
  DelegateStep,
  type CallableDelegator,
  type DelegateStepOptions,
} from "../../operations/delegate.ts";
import { definePlugin, type Plugin } from "../../kernel/plugin.ts";
import { registerShippedPlugin } from "../../kernel/defaults.ts";
import {
  ENFORCEMENT,
  type EnforcementPositions,
} from "../../kernel/positions.ts";
import { ValidateStep } from "../../operations/validate.ts";

/**
 * The framework's gate: what fills the `authorize` position unless an
 * installed plugin replaces {@link ENFORCEMENT}.
 */
export const enforcementProvider: EnforcementPositions = {
  authorize: (options) => new ValidateStep(authorize(options)),
};

/** `ex.auth`: who the exchange is acting for. */
export interface AuthFacet {
  /**
   * The authenticated principal, when one has been resolved: by a source
   * that verifies credentials, by `.authenticate()`, or by `.delegate()`.
   */
  readonly principal: Principal | undefined;
}

export const authSteps = {
  /**
   * Establish the authenticated principal for the exchange. The resolver
   * returns identity claims you have verified yourself (an e-mail sender, a
   * Slack signature, a webhook HMAC); they are minted into a branded
   * principal and attached to the exchange. Return `undefined` to leave the
   * caller anonymous. Body type is unchanged.
   *
   * This is the explicit, greppable way to mint identity. `authorize()`
   * trusts only principals established this way (or by a source verifier);
   * a plain object written via `.header("routecraft.auth.principal", ...)`
   * is rejected.
   *
   * @param resolver - Returns the caller's claims, or `undefined` to skip
   * @example
   * ```ts
   * craft()
   *   .from(mail("INBOX"))
   *   .filter(verifiedSenders)
   *   .authenticate((ex) => {
   *     const sender = ex.headers["routecraft.mail.sender"];
   *     return {
   *       scheme: "email",
   *       subject: sender.address,
   *       roles: sender.address.endsWith("@acme.com") ? ["internal"] : [],
   *     };
   *   })
   *   .authorize({ roles: ["internal"] })
   *   .to(dest)
   * ```
   */
  authenticate: (resolver: CallableAuthenticator<Body>) =>
    step<Body, Body>(
      new AuthenticateStep(resolver as CallableAuthenticator<unknown>),
    ),
  /**
   * Mark the exchange's principal as being exercised by an actor (an agent,
   * a service) on the subject's behalf. The resolver returns the actor's
   * identity claims plus the consent-derived scope ceiling; they are minted
   * into a delegated principal (subject unchanged, actor set, scopes
   * intersected). Body type is unchanged.
   *
   * A resolver that returns `undefined` (no consent record) fails closed by
   * default: the subject's direct principal is STRIPPED so the continuation
   * runs anonymous and downstream `authorize()` refuses with RC5012. The
   * strip skips anonymous exchanges, already-delegated principals, and
   * autonomous agent subjects (`subjectProfile: "ai_agent"`). Pass
   * `{ otherwise: "keep" }` when the continuation serves the caller
   * directly and an ungranted caller should keep acting as themselves.
   *
   * @param resolver - Returns the delegation directive, or `undefined`
   * @param options - No-consent behavior; default `{ otherwise: "drop" }`
   * @example
   * ```ts
   * craft()
   *   .from(mail("INBOX"))
   *   .authenticate(mailPrincipal)
   *   .delegate((ex) => {
   *     const grant = grants.find(ex.auth.principal?.subject, "agent:zoe");
   *     if (!grant) return undefined;
   *     return { actor: zoeIdentity, scopes: grant.scopes, grantId: grant.id };
   *   })
   *   .to(agent("zoe"))
   * ```
   */
  delegate: (
    resolver: CallableDelegator<Body>,
    options?: DelegateStepOptions,
  ) =>
    step<Body, Body>(
      new DelegateStep(resolver as CallableDelegator<unknown>, options),
    ),
};

/**
 * The plugin that provides {@link ENFORCEMENT}, the `.authenticate()` and
 * `.delegate()` steps and the `ex.auth` facet. Installed by default.
 */
export function authPlugin(): AuthPlugin {
  return definePlugin({
    id: "routecraft.auth",
    provides: [ENFORCEMENT],
    steps: authSteps,
    facet: (exchange: Exchange): AuthFacet => ({
      principal: principalOf(exchange),
    }),
    bind(c) {
      c.provide(ENFORCEMENT, enforcementProvider);
    },
  });
}

declare module "@routecraft/routecraft" {
  interface ShippedPluginTypes {
    auth: AuthPlugin;
  }
  interface DefaultPluginTypes {
    auth: AuthPlugin;
  }
}

/**
 * The auth plugin's descriptor type, for typing a project's routes. Declared
 * rather than inferred from {@link authPlugin}, so typing a route never
 * depends on the plugin's implementation.
 */
export interface AuthPlugin extends Plugin {
  readonly id: "routecraft.auth";
  readonly steps: typeof authSteps;
  readonly facet: (exchange: Exchange) => AuthFacet;
}

registerShippedPlugin(authPlugin, { default: true });
