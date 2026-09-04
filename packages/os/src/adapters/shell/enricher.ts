import { randomUUID } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import {
  getExchangeContext,
  getExchangeRoute,
  parseDuration,
  rcError,
  type Enricher,
  type Exchange,
  type StepSignalContext,
} from "@routecraft/routecraft";
import { resolve } from "../../shared/resolvable.ts";
import {
  resolveIsolation,
  type ExecutionOutcome,
  type HostTier,
  type Invocation,
  type IsolationRequest,
  type ProcessIo,
} from "./isolation/index.ts";
import { loadExeca } from "./peers.ts";
import { SHELL_DEFAULTS, type ShellPluginOptions } from "./plugin.ts";
import {
  BoundedOutput,
  buildEnv,
  exitCodeForSignal,
  sanitiseArgs,
} from "./shared.ts";
import type {
  IsolationName,
  ShellArgs,
  ShellOptions,
  ShellResult,
} from "./types.ts";

/** Cap on captured output, per stream, when nothing configures one. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Grace period between the timeout's SIGTERM and a SIGKILL. */
const FORCE_KILL_AFTER_MS = 5_000;

/**
 * Runs a command and produces its output. The Enricher (fetch) role is the
 * adapter's only role: `.to()` replaces the body with the result,
 * `.enrich()` merges it, `.tap()` discards it. Output is always captured,
 * because a command's output is usually why it was run.
 */
export class ShellEnricherAdapter<T = unknown> implements Enricher<
  T,
  ShellResult
> {
  readonly adapterId = "routecraft.adapter.shell";

  constructor(
    private readonly command: string,
    private readonly args: ShellArgs<T> | undefined,
    private readonly options: ShellOptions<T>,
  ) {
    if (typeof command !== "string" || command.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `shell(): the command must be a non-empty string naming a program to run.`,
      });
    }
  }

  async fetch(
    exchange: Exchange<T>,
    ctx?: StepSignalContext,
  ): Promise<ShellResult> {
    const defaults =
      getExchangeContext(exchange)?.getStore(SHELL_DEFAULTS) ??
      ({} as ShellPluginOptions);

    const tier = resolveIsolation(this.options.isolation, defaults.isolation);
    await tier.ensureAvailable();

    const request: IsolationRequest = {
      network: this.options.network ?? false,
      mapRootUser: this.options.mapRootUser ?? false,
      ...containerOptions(this.options, exchange),
    };
    // Checked before the command is built, because the answer is a
    // property of the call rather than of anything it produces. A tier
    // that cannot honour an option refuses it here; silently dropping it
    // is how a caller ends up believing in containment it never had.
    const refusal = tier.refuse(request);
    if (refusal !== undefined) {
      throw rcError("OS1004", undefined, {
        message: `shell(): ${refusal}`,
      });
    }

    const rawArgs =
      typeof this.args === "function" ? this.args(exchange) : (this.args ?? []);
    const target = {
      file: this.command,
      args: await sanitiseArgs(rawArgs),
    };

    const limit =
      this.options.maxOutputBytes ??
      defaults.maxOutputBytes ??
      DEFAULT_MAX_OUTPUT_BYTES;
    const configuredTimeout =
      resolve(this.options.timeout, exchange) ?? defaults.timeout;
    const timeout =
      configuredTimeout === undefined
        ? undefined
        : parseDuration(configuredTimeout, "shell({ timeout })");
    const cwd = resolve(this.options.cwd, exchange);
    const env = buildEnv(
      this.options.passEnv,
      resolve(this.options.env, exchange),
      tier.kind === "container" ? tier.home : undefined,
    );
    const stdin = resolveStdin(this.options.stdin, exchange);
    const io: ProcessIo = {
      ...(cwd === undefined ? {} : { cwd }),
      env,
      ...(stdin === undefined ? {} : { stdin }),
      ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      maxOutputBytes: limit,
    };

    const outcome: HostOutcome =
      tier.kind === "container"
        ? await tier.execute(target, request, {
            ...io,
            defaultName: defaultContainerName(exchange),
          })
        : await this.spawn(tier, target, request, io);

    const out = outcome.stdout;
    const err = outcome.stderr;
    const result: ShellResult = {
      stdout: out.text,
      stderr: err.text,
      exitCode: outcome.exitCode,
      truncated: out.truncated || err.truncated,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
    };

    if (outcome.timedOut) {
      throw rcError("OS1003", ranAndFailedCause(result, out.text), {
        message:
          `"${this.command}" exceeded its ${String(timeout)}ms timeout and was killed.` +
          (this.options.network === true
            ? ""
            : ` Network egress is denied unless the call sets network: true, so a command waiting on the network will always reach its timeout.`),
      });
    }

    if (outcome.spawnFailure !== undefined) {
      throw rcError("OS1002", toCause(outcome.spawnFailure), {
        message:
          `"${this.command}" could not be started.` +
          (/\s/.test(this.command)
            ? ` The command contains whitespace, so it is being looked up as one program name: pass the arguments separately, as shell("${this.command.split(/\s+/)[0]}", [...]).`
            : ` Check the program is installed and on the PATH granted to the command; shell() passes only the documented baseline plus what the call declares.`),
      });
    }

    if (result.exitCode !== 0 && (this.options.failOnNonZero ?? true)) {
      throw rcError("OS1002", ranAndFailedCause(result, out.text), {
        message:
          `"${this.command}" exited with code ${result.exitCode}. ` +
          `Pass failOnNonZero: false if this command's exit code is data rather than failure.` +
          deniedEgressNote(tier.name, this.options.network),
      });
    }

    return result;
  }

  /**
   * The host path: wrap the invocation in the tier and spawn it directly.
   * Reports the same outcome shape a container tier does, so what follows
   * (timeout, spawn failure, exit code) is decided once.
   */
  private async spawn(
    tier: HostTier,
    target: Invocation,
    request: IsolationRequest,
    io: ProcessIo,
  ): Promise<HostOutcome> {
    const invocation = tier.wrap(target, request);
    const { execa } = await loadExeca();
    const stdout = new BoundedOutput(io.maxOutputBytes);
    const stderr = new BoundedOutput(io.maxOutputBytes);
    const subprocess = execa(invocation.file, [...invocation.args], {
      ...(io.cwd === undefined ? {} : { cwd: io.cwd }),
      env: io.env,
      // Without this execa merges the parent's environment back in, which
      // would make the whole env-scoping contract a lie.
      extendEnv: false,
      reject: false,
      buffer: false,
      // `input` is written and closed before the command reads, so a
      // secret on stdin is never on the command line or in the env.
      ...(io.stdin === undefined ? { stdin: "ignore" } : { input: io.stdin }),
      // Deliberately NOT encoding: "buffer". It is the natural way to ask
      // for binary chunks, and under Bun execa forwards it to the stream
      // constructor, which rejects "buffer" as an unknown encoding and
      // fails the spawn. Decoded chunks are re-encoded when captured, so
      // the byte cap still counts bytes.
      ...(io.timeoutMs === undefined ? {} : { timeout: io.timeoutMs }),
      ...(io.signal ? { cancelSignal: io.signal } : {}),
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    });

    subprocess.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
    subprocess.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));

    const outcome = await subprocess;
    return {
      stdout: stdout.result(),
      stderr: stderr.result(),
      exitCode: outcome.exitCode ?? exitCodeForSignal(outcome.signal),
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      timedOut: outcome.timedOut,
      ...(isSpawnFailure(outcome) ? { spawnFailure: outcome } : {}),
    };
  }
}

/** A host outcome carries the runner's own error when the program never ran. */
type HostOutcome = ExecutionOutcome & { readonly spawnFailure?: unknown };

/**
 * The container options, resolved for this call and checked before any
 * tier sees them. An absent option stays absent, so a host tier's refusal
 * fires only for what the call actually set.
 */
function containerOptions<T>(
  options: ShellOptions<T>,
  exchange: Exchange<T>,
): Pick<IsolationRequest, "image" | "mounts" | "name"> {
  const image = resolve(options.image, exchange);
  if (
    image !== undefined &&
    (typeof image !== "string" || image.trim() === "")
  ) {
    throw rcError("RC5003", undefined, {
      message: `shell(): "image" must resolve to a non-empty image reference; got ${JSON.stringify(image)}.`,
    });
  }
  const mounts = resolve(options.mounts, exchange);
  if (mounts !== undefined) {
    if (!Array.isArray(mounts)) {
      throw rcError("RC5003", undefined, {
        message: `shell(): "mounts" must resolve to an array of { host, container, readonly? }.`,
      });
    }
    for (const [index, mount] of mounts.entries()) {
      if (
        typeof mount !== "object" ||
        mount === null ||
        typeof mount.host !== "string" ||
        typeof mount.container !== "string"
      ) {
        throw rcError("RC5003", undefined, {
          message: `shell(): mounts[${index}] must be { host, container, readonly? } with both paths as strings.`,
        });
      }
      // Absolute on both sides: a relative host path would resolve against
      // the daemon's working directory, which is nowhere the author meant,
      // and the API reads a relative container path as a volume name.
      if (!isAbsolute(mount.host) || !isAbsolute(mount.container)) {
        throw rcError("RC5003", undefined, {
          message: `shell(): mounts[${index}] must use absolute paths on both sides; got host "${mount.host}" and container "${mount.container}".`,
        });
      }
      if (mount.host.includes(":") || mount.container.includes(":")) {
        throw rcError("RC5003", undefined, {
          message: `shell(): mounts[${index}] paths cannot contain ":", which the daemon reads as the mount separator.`,
        });
      }
      // Normal form only: "/work/../../etc" is absolute and is /etc. A
      // route that builds a mount from data decides which directory it
      // exposes, and a ".." segment lets the data decide instead.
      if (!isNormalPath(mount.host) || !isNormalPath(mount.container)) {
        throw rcError("RC5003", undefined, {
          message: `shell(): mounts[${index}] paths must be in normal form, with no "." or ".." segments and no repeated or trailing separators; got host "${mount.host}" and container "${mount.container}". A ".." from data would expose a directory the route never named.`,
        });
      }
    }
  }
  const name = resolve(options.name, exchange);
  if (name !== undefined && !CONTAINER_NAME.test(name)) {
    throw rcError("RC5003", undefined, {
      message: `shell(): "name" must match ${CONTAINER_NAME.source} (a container name); got ${JSON.stringify(name)}.`,
    });
  }
  return {
    ...(image !== undefined ? { image } : {}),
    ...(mounts !== undefined ? { mounts } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** A path already in normal form: no `.` or `..` segments, no repeated or trailing separators. */
function isNormalPath(path: string): boolean {
  return (
    posix.normalize(path) === path && (path.length === 1 || !path.endsWith("/"))
  );
}

/** The charset the daemon accepts for a container name. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * `rc-<routeId>-<exchangeId>`, with the route id reduced to the container
 * name charset. A synthetic exchange with no route names itself by its id.
 */
function defaultContainerName(exchange: Exchange<unknown>): string {
  const routeId = getExchangeRoute(exchange)?.definition.id ?? "route";
  const safeRoute = routeId.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  // A synthetic exchange with no id (a bare object in a test) still needs
  // a unique name, or two calls collide on the daemon.
  const id = typeof exchange.id === "string" ? exchange.id : randomUUID();
  return `rc-${safeRoute}-${id}`.replace(/^[^a-zA-Z0-9]+/, "rc-");
}

/** Resolve `stdin` to bytes, refusing a value that is neither text nor bytes. */
function resolveStdin<T>(
  source: ShellOptions<T>["stdin"],
  exchange: Exchange<T>,
): Uint8Array | undefined {
  const value = resolve(source, exchange);
  if (value === undefined) return undefined;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return value;
  throw rcError("RC5003", undefined, {
    message: `shell(): "stdin" must resolve to a string or a Uint8Array; got ${typeof value}.`,
  });
}

/**
 * Distinguish "the program never ran" from "the program ran and failed".
 * Both surface as a rejected-but-not-thrown result under `reject: false`,
 * and they need different advice: one is a configuration problem, the
 * other is the command's own verdict.
 */
function isSpawnFailure(outcome: {
  exitCode?: number;
  signal?: string;
}): boolean {
  return outcome.exitCode === undefined && outcome.signal === undefined;
}

function toCause(outcome: unknown): Error | undefined {
  return outcome instanceof Error ? outcome : undefined;
}

/**
 * A sentence naming denied egress, for a failure that ran without it.
 *
 * A command needing the network fails fast with a non-zero exit rather
 * than timing out, so it lands on the `OS1002` path where the timeout
 * hint never appears. That the run had no egress is a fact of the run,
 * not a guess at the cause, which is why it is stated whenever it holds
 * rather than only when the output looks network-shaped.
 *
 * Empty when the call granted egress. A tier that cannot deny it refuses
 * the call outright now, so reaching here at all means the tier denies
 * egress and the only question is whether this call asked for it back.
 */
function deniedEgressNote(tier: IsolationName, network: boolean | undefined) {
  if (network === true) return "";
  return (
    ` The command ran without network access, which is the default under the ${tier} tier;` +
    ` set network: true if it needed the network.`
  );
}

/**
 * The cause for a command that ran, carrying what it said and how it ended.
 *
 * `OS1002` tells a route it can read `stderr` and `exitCode` off the cause.
 * A bare `Error` carrying only the text does not honour that, so the fields
 * are attached here rather than left to the message.
 */
function ranAndFailedCause(result: ShellResult, stdout: string): Error {
  const cause = new Error(result.stderr.trim() || stdout.trim());
  return Object.assign(cause, {
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
  });
}
