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
  /**
   * Why this tier cannot honour the request, or `undefined` when it can.
   *
   * A tier refuses an option it cannot satisfy; it never ignores one. The
   * option that matters most here is the one easiest to drop silently:
   * `network` defaults to denied, and a tier that cannot deny egress was
   * handing back full network access while the default said otherwise.
   * Denied egress is also the strongest promise this adapter makes, since
   * the `unshare` tier deliberately does not contain filesystem reads, so
   * no-network is what stands between reading a credential and sending it
   * somewhere.
   *
   * The reason is a sentence for the caller, naming what the tier cannot
   * do and how to ask for it out loud. Required rather than optional, so
   * a new tier has to decide what it cannot deliver rather than inherit
   * silence by leaving a method off.
   */
  refuse(request: IsolationRequest): string | undefined;
  /** Wrap the target invocation in whatever the tier needs to contain it. */
  wrap(target: Invocation, request: IsolationRequest): Invocation;
}
