import {
  authorityOf,
  defaultAuthority,
  delegate as delegateWith,
  type CraftContext,
  type DelegateOptions,
  type Principal,
  type PrincipalClaims,
} from "../../src/index.ts";
import type { IngressHost } from "../../src/plugins/server/registry.ts";

/**
 * `delegate()` against the default authority, for tests that build a chain
 * with no application around it.
 */
export function delegate(
  subject: Principal,
  actor: PrincipalClaims,
  options: DelegateOptions = {},
): Principal {
  return delegateWith(subject, actor, options, defaultAuthority);
}

/** The ingress host a context's own server plugin would hand a mount registry. */
export function ingressHostOf(context: CraftContext): IngressHost {
  return {
    logger: context.logger,
    emit: (event, details) => context.emit(event, details),
    authority: authorityOf(context),
  };
}
