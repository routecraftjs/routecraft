import type { IsolationName } from "../types.ts";

/** A program and its arguments, ready to spawn. Never a shell command line. */
export interface Invocation {
  readonly file: string;
  readonly args: readonly string[];
}

/** What the call asked the tier to contain. */
export interface IsolationRequest {
  /** Allow network egress. */
  readonly network: boolean;
  /** Map the caller to root inside the tier's user namespace. */
  readonly mapRootUser: boolean;
}

/**
 * One isolation mechanism.
 *
 * A tier is a pure wrapper around an invocation plus an availability
 * probe. It never reaches into how the command is spawned, how output is
 * captured, or how arguments are sanitised, which is what keeps the
 * deferred tiers (`docker` #647, `seatbelt` #646) purely additive: a new
 * tier is a new module implementing this interface and a new entry in the
 * registry, with nothing else in the adapter to change.
 */
export interface IsolationTier {
  readonly name: IsolationName;
  /**
   * Resolve whether this host can provide the tier, throwing `OS1001`
   * naming the cause and the ways out when it cannot.
   *
   * Availability is a property of the host, not of the call, so the answer
   * is probed once and cached for the process. Tiers never degrade to a
   * weaker mechanism: a route that believes it is contained and is not is
   * worse than one that fails.
   */
  ensureAvailable(): Promise<void>;
  /** Wrap the target invocation in whatever the tier needs to contain it. */
  wrap(target: Invocation, request: IsolationRequest): Invocation;
}
