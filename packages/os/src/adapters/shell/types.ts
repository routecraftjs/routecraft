import type { Duration, Exchange } from "@routecraft/routecraft";
import type { Resolvable } from "../../shared/resolvable.ts";
import type { ShellArg } from "./untrusted.ts";

/**
 * Isolation mechanisms `shell()` can run a command under. Each tier is
 * named for the mechanism that provides it, so the name is the promise:
 * `unshare` means Linux kernel namespaces and nothing more, `docker` means
 * a throwaway container on a Docker Engine daemon, and a reader who knows
 * what each does already knows what the tier does.
 *
 * `seatbelt` (#646) joins this union when it ships.
 */
export type IsolationName = "none" | "unshare" | "docker";

/**
 * One host path exposed inside a container. The route decides what is
 * exposed: a mount is a grant, so it is declared where the command is
 * written, and a path outside the declared list is not visible to the
 * command at all.
 */
export interface ShellMount {
  /** Absolute path on the host. */
  readonly host: string;
  /** Absolute path inside the container. */
  readonly container: string;
  /** Mount read-only. Off by default, because a workspace is for writing. */
  readonly readonly?: boolean;
}

/** Arguments for a command: a fixed list, or derived from the exchange. */
export type ShellArgs<T> =
  readonly ShellArg[] | ((exchange: Exchange<T>) => readonly ShellArg[]);

/**
 * Options shared by every `shell()` call. Per-call values here beat the
 * `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats
 * `shellPlugin()` context defaults: an operator can harden a loosely
 * configured deployment without being able to quietly weaken what a route
 * explicitly demanded. Isolation is the only option an operator can
 * override from the environment.
 */
export interface ShellOptions<T = unknown> {
  /**
   * Isolation tier. Defaults to `unshare`, which is Linux-only: on a host
   * that cannot provide the requested tier the call fails with `OS1001`
   * rather than running with less isolation than it claims. Write
   * `isolation: "none"` to run without isolation deliberately.
   */
  isolation?: IsolationName;
  /**
   * Allow network egress. Denied by default: the route grants what the
   * command may reach, the same way it grants environment variables.
   *
   * A tier that cannot deny egress refuses the call rather than ignoring
   * the option, so `isolation: "none"` requires `network: true` beside it.
   * Accepting egress is then something the call says out loud, instead of
   * something a default claimed and did not deliver.
   */
  network?: boolean;
  /**
   * Map the caller to root inside the isolation tier's user namespace
   * instead of to itself. Off by default: a process that believes it is
   * root will chown and chmod things it should not, and workloads that
   * genuinely need root inside are the minority.
   */
  mapRootUser?: boolean;
  /**
   * Working directory for the command. Defaults to the host process's on
   * the host tiers and to the image's on the docker tier.
   */
  cwd?: Resolvable<T, string>;
  /**
   * Environment variables granted to the command, by value, static or
   * resolved from the exchange. These are added to the documented baseline
   * (`PATH`, `HOME`, `LANG`, `TZ`) and override it where the names collide.
   *
   * A grant surface, so the same rule `untrusted()` states for arguments
   * applies to the names: never derive a variable NAME from data. A value
   * may come from the exchange; the set of variables a command may reach
   * is decided where the command is written. On the docker tier the values
   * are visible in `docker inspect`; a secret goes through `stdin`.
   */
  env?: Resolvable<T, Record<string, string>>;
  /**
   * Parent-process environment variables to forward by name. Nothing is
   * forwarded by default, so no credential-bearing variable reaches a
   * command that did not ask for it. A named variable that is unset in the
   * parent is simply absent; it is not an error.
   */
  passEnv?: readonly string[];
  /**
   * Bytes written to the command's standard input before it reads, then
   * closed, static or resolved from the exchange. Without it stdin is
   * closed at once.
   *
   * The place for a value that must not appear anywhere else: a token on
   * stdin reaches the command and nothing besides it, where the same
   * token in `env` is in `docker inspect` and in `args` is in the process
   * list.
   */
  stdin?: Resolvable<T, string | Uint8Array>;
  /**
   * How long before the command (and anything it spawned) is killed,
   * static or resolved from the exchange, so two exchanges through one
   * step can carry different deadlines.
   */
  timeout?: Resolvable<T, Duration>;
  /**
   * The container image the command runs in. Docker tier only, and
   * required there with no default: selecting the tier without an image is
   * a configuration error naming this option. Passed to the daemon as one
   * field, never interpolated, so a value resolved from data cannot carry
   * flags. Never pulled: an image that is not present fails the call
   * naming it. A host tier refuses this option with `OS1004`.
   */
  image?: Resolvable<T, string>;
  /**
   * Host paths exposed inside the container. Docker tier only; a host tier
   * refuses it with `OS1004`. Both paths must be absolute. The route
   * decides what is exposed, and nothing outside this list is visible to
   * the command.
   */
  mounts?: Resolvable<T, readonly ShellMount[]>;
  /**
   * Container name, so an operator can find a run (`docker ps`, `docker
   * inspect`) and a later re-attach can name it. Docker tier only.
   * Defaults to `rc-<routeId>-<exchangeId>`.
   */
  name?: Resolvable<T, string>;
  /**
   * Throw `OS1002` when the command exits non-zero. On by default, because
   * a route whose `git push` failed should not continue as though it had.
   * Set false for commands whose exit code is data rather than failure
   * (`grep` with no match, `diff` with differences) and read `exitCode`
   * off the result instead.
   */
  failOnNonZero?: boolean;
  /**
   * Cap on captured output, per stream, in bytes. Defaults to 8 MiB.
   * Overflow keeps the head and the tail with a marker between them and
   * sets `truncated`, rather than failing: on a long build log the tail is
   * usually the part that explains the failure.
   */
  maxOutputBytes?: number;
}

/** What a command produced. */
export interface ShellResult {
  /** Captured standard output, capped per `maxOutputBytes`. */
  stdout: string;
  /** Captured standard error, capped per `maxOutputBytes`. */
  stderr: string;
  /** Exit status. `0` on success. */
  exitCode: number;
  /** Signal that killed the command, when one did. */
  signal?: string;
  /** True when either stream hit `maxOutputBytes` and was capped. */
  truncated: boolean;
}
