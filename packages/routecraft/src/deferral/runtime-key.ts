import { port } from "../kernel/port.ts";
import type { DeferralRuntime } from "./config.ts";

/**
 * The port the deferral plugin provides: where continuations are kept, how
 * resume tokens are signed, and the default deadline.
 *
 * The kernel's park, resume and sweep, the `ex.deferral` facet and any
 * plugin that parks work aside (agent sessions) reach one resolved store and
 * one signer per application through it, never through each other.
 *
 * It lives in this leaf module rather than next to
 * {@link createDeferralRuntime} because `exchange.ts` reads it to build the
 * `ex.deferral` affordance, and importing `config.ts` from there would pull
 * the store backends (and, through them, the context) into a runtime cycle
 * rooted at the exchange.
 */
export const CONTINUATIONS = port<DeferralRuntime>(
  "routecraft.continuations@1",
);
