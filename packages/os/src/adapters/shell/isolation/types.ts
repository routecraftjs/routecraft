import type { IsolationName, ShellMount } from "../types.ts";

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
  /** Container image, resolved for this call. Container tiers only. */
  readonly image?: string;
  /** Host paths to expose, resolved for this call. Container tiers only. */
  readonly mounts?: readonly ShellMount[];
  /** Container name, resolved for this call. Container tiers only. */
  readonly name?: string;
}

/**
 * Everything a container tier needs beyond the invocation to run it:
 * what the host tiers hand to the process runner, in one place.
 */
export interface ExecutionIo {
  /** Working directory inside the container. */
  readonly cwd?: string;
  /** The full environment, already built from the baseline and the grants. */
  readonly env: Readonly<Record<string, string>>;
  /** Bytes written to the command's stdin before it reads, then closed. */
  readonly stdin?: Uint8Array;
  /** Milliseconds before the command is killed. */
  readonly timeoutMs?: number;
  /** Cancellation from the route or the step. */
  readonly signal?: AbortSignal;
  /** Cap on captured output, per stream, in bytes. */
  readonly maxOutputBytes: number;
  /** Default container name when the call resolved none. */
  readonly defaultName: string;
}

/** What a container tier reports when the command ends. */
export interface ExecutionOutcome {
  readonly stdout: { readonly text: string; readonly truncated: boolean };
  readonly stderr: { readonly text: string; readonly truncated: boolean };
  readonly exitCode: number;
  /** Signal the tier sent to end the command, when it did. */
  readonly signal?: string;
  /** The timeout elapsed and the tier killed the command. */
  readonly timedOut: boolean;
}

/**
 * One isolation mechanism.
 *
 * A host tier is a pure wrapper around an invocation plus an availability
 * probe: `wrap` returns what to spawn and the adapter spawns it. A
 * container tier cannot be expressed as a wrapper, because a container is
 * driven through a daemon's API rather than spawned, so it implements
 * `execute` instead and the adapter hands it the invocation and the io.
 * Either way the tier never touches argument hygiene, and a new tier is a
 * new module plus a registry entry.
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
   * somewhere. The container options (`image`, `mounts`, `name`) are
   * refused by every host tier for the same reason: an image that is never
   * used is a containment the author believes in and does not have.
   *
   * The reason is a sentence for the caller, naming what the tier cannot
   * do and how to ask for it out loud. Required rather than optional, so
   * a new tier has to decide what it cannot deliver rather than inherit
   * silence by leaving a method off.
   */
  refuse(request: IsolationRequest): string | undefined;
  /** Wrap the target invocation in whatever the tier needs to contain it. Host tiers. */
  wrap?(target: Invocation, request: IsolationRequest): Invocation;
  /** Run the target inside the tier's container and report what it produced. Container tiers. */
  execute?(
    target: Invocation,
    request: IsolationRequest,
    io: ExecutionIo,
  ): Promise<ExecutionOutcome>;
}
