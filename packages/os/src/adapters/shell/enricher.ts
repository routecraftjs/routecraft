import {
  getExchangeContext,
  rcError,
  type Enricher,
  type Exchange,
  type StepSignalContext,
} from "@routecraft/routecraft";
import { resolve } from "../../shared/resolvable.ts";
import { resolveIsolation } from "./isolation/index.ts";
import { loadExeca } from "./peers.ts";
import { SHELL_DEFAULTS, type ShellPluginOptions } from "./plugin.ts";
import {
  BoundedOutput,
  buildEnv,
  exitCodeForSignal,
  sanitiseArgs,
} from "./shared.ts";
import type { ShellArgs, ShellOptions, ShellResult } from "./types.ts";

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

    const rawArgs =
      typeof this.args === "function" ? this.args(exchange) : (this.args ?? []);
    const target = {
      file: this.command,
      args: await sanitiseArgs(rawArgs),
    };
    const invocation = tier.wrap(target, {
      network: this.options.network ?? false,
      mapRootUser: this.options.mapRootUser ?? false,
    });

    const limit =
      this.options.maxOutputBytes ??
      defaults.maxOutputBytes ??
      DEFAULT_MAX_OUTPUT_BYTES;
    const timeout = this.options.timeout ?? defaults.timeout;

    const { execa } = await loadExeca();
    const stdout = new BoundedOutput(limit);
    const stderr = new BoundedOutput(limit);

    const cwd = resolve(this.options.cwd, exchange);
    const subprocess = execa(invocation.file, [...invocation.args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: buildEnv(this.options.passEnv, this.options.env),
      // Without this execa merges the parent's environment back in, which
      // would make the whole env-scoping contract a lie.
      extendEnv: false,
      reject: false,
      buffer: false,
      stdin: "ignore",
      // Deliberately NOT encoding: "buffer". It is the natural way to ask
      // for binary chunks, and under Bun execa forwards it to the stream
      // constructor, which rejects "buffer" as an unknown encoding and
      // fails the spawn. Decoded chunks are re-encoded when captured, so
      // the byte cap still counts bytes.
      ...(timeout === undefined ? {} : { timeout }),
      ...(ctx?.signal ? { cancelSignal: ctx.signal } : {}),
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    });

    subprocess.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
    subprocess.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));

    const outcome = await subprocess;
    const out = stdout.result();
    const err = stderr.result();
    const result: ShellResult = {
      stdout: out.text,
      stderr: err.text,
      exitCode: outcome.exitCode ?? exitCodeForSignal(outcome.signal),
      truncated: out.truncated || err.truncated,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
    };

    if (outcome.timedOut) {
      throw rcError("OS1003", new Error(err.text.trim() || out.text.trim()), {
        message:
          `"${this.command}" exceeded its ${String(timeout)}ms timeout and was killed.` +
          (this.options.network === true
            ? ""
            : ` Network egress is denied unless the call sets network: true, so a command waiting on the network will always reach its timeout.`),
      });
    }

    if (isSpawnFailure(outcome)) {
      throw rcError("OS1002", toCause(outcome), {
        message:
          `"${this.command}" could not be started.` +
          (/\s/.test(this.command)
            ? ` The command contains whitespace, so it is being looked up as one program name: pass the arguments separately, as shell("${this.command.split(/\s+/)[0]}", [...]).`
            : ` Check the program is installed and on the PATH granted to the command; shell() passes only the documented baseline plus what the call declares.`),
      });
    }

    if (result.exitCode !== 0 && (this.options.failOnNonZero ?? true)) {
      throw rcError("OS1002", new Error(err.text.trim() || out.text.trim()), {
        message:
          `"${this.command}" exited with code ${result.exitCode}. ` +
          `Pass failOnNonZero: false if this command's exit code is data rather than failure.`,
      });
    }

    return result;
  }
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
