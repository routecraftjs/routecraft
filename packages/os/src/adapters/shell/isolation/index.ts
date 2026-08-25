import { rcError } from "@routecraft/routecraft";
import type { IsolationName } from "../types.ts";
import { noneTier } from "./none.ts";
import { unshareTier } from "./unshare.ts";
import type { IsolationTier } from "./types.ts";

export type { Invocation, IsolationRequest, IsolationTier } from "./types.ts";

/**
 * Every tier this build can provide, keyed by the mechanism it is named
 * for. A deferred tier is absent from this map rather than present and
 * stubbed: a name that resolves to something weaker than it says would be
 * the silent downgrade the design exists to prevent.
 */
const TIERS: Record<IsolationName, IsolationTier> = {
  none: noneTier,
  unshare: unshareTier,
};

/** The tier a call gets when nothing chooses one. Isolated, never raw. */
const DEFAULT_ISOLATION: IsolationName = "unshare";

/** Operator override, sitting between the call site and plugin defaults. */
const ISOLATION_ENV_VAR = "ROUTECRAFT_SHELL_ISOLATION";

/**
 * Pick the tier for a call.
 *
 * Precedence is per-call, then the `ROUTECRAFT_SHELL_ISOLATION` operator
 * override, then `shellPlugin()` context defaults, then the built-in
 * default. The env override sits above plugin config so an operator can
 * harden a loosely configured deployment, and below the call site so a
 * route that explicitly demanded a tier is never quietly given another.
 *
 * @param perCall - `isolation` passed to `shell()`, if any
 * @param fromPlugin - `isolation` configured on `shellPlugin()`, if any
 */
export function resolveIsolation(
  perCall: IsolationName | undefined,
  fromPlugin: IsolationName | undefined,
): IsolationTier {
  const name = perCall ?? readIsolationEnv() ?? fromPlugin ?? DEFAULT_ISOLATION;
  const tier = TIERS[name];
  if (!tier) {
    throw rcError("RC5003", undefined, {
      message:
        `shell(): unknown isolation tier "${String(name)}". ` +
        `This build provides: ${Object.keys(TIERS).join(", ")}.`,
    });
  }
  return tier;
}

/**
 * Read the operator override, refusing a value this build cannot provide
 * rather than ignoring it. An operator who set the variable meant to
 * change something, and a typo that silently leaves the default in place
 * is the failure mode that gets discovered after an incident.
 */
function readIsolationEnv(): IsolationName | undefined {
  const raw = process.env[ISOLATION_ENV_VAR]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!(raw in TIERS)) {
    throw rcError("RC5003", undefined, {
      message:
        `${ISOLATION_ENV_VAR} is set to "${raw}", which is not an isolation tier this build provides. ` +
        `Valid values: ${Object.keys(TIERS).join(", ")}.`,
    });
  }
  return raw as IsolationName;
}
