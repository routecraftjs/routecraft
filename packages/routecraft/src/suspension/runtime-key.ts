import type { SuspensionRuntime } from "./config.ts";

/**
 * Context-store key holding the resolved suspension runtime.
 *
 * Exported so the executor, the resume path, and the sweeper reach one
 * resolved store and one signer per context rather than each building their
 * own.
 *
 * It lives in this leaf module rather than next to
 * {@link createSuspensionRuntime} because `exchange.ts` reads the key to
 * build the `ex.suspension` affordance, and importing `config.ts` from
 * there would pull the store backends (and, through them, the context) into
 * a runtime cycle rooted at the exchange. The type-only import above is
 * erased, so this module has no runtime dependencies at all.
 */
export const SUSPENSION_RUNTIME = "routecraft.suspension.runtime" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [SUSPENSION_RUNTIME]: SuspensionRuntime;
  }
}
