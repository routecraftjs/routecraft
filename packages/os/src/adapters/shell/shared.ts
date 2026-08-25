import { constants as osConstants } from "node:os";
import { rcError } from "@routecraft/routecraft";
import { loadShescape } from "./peers.ts";
import { isUntrusted, type ShellArg } from "./untrusted.ts";

/**
 * Environment variables every command gets unless the call overrides them.
 *
 * The scoping rule is that a command may reach only what the route grants
 * it, but a literally empty environment fails in ways that read as bugs
 * rather than as policy: without `PATH` nothing resolves, and without
 * `HOME` tools that keep per-user state (`git`, `ssh`) misbehave in
 * confusing rather than obvious ways. These four are the smallest set that
 * makes an ordinary command work, and none of them carries a credential.
 *
 * @internal
 */
export const ENV_BASELINE = ["PATH", "HOME", "LANG", "TZ"] as const;

/**
 * Build the environment a command runs with: the baseline, plus the
 * parent variables the call forwards by name, plus its explicit values.
 *
 * Nothing else is forwarded. A name listed in `passEnv` but unset in the
 * parent is simply absent rather than an error, so a route does not have
 * to know which of its optional variables an operator configured.
 *
 * @internal
 */
export function buildEnv(
  passEnv: readonly string[] | undefined,
  env: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [...ENV_BASELINE, ...(passEnv ?? [])]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...(env ?? {}) };
}

/**
 * Apply argument hygiene, returning plain strings ready to spawn.
 *
 * What stops an argument becoming a command is that `shell()` spawns the
 * program directly and never through a shell, so `; rm -rf /` reaches the
 * program as the literal text it is. What remains, and what this function
 * adds, is control-character hygiene on every argument plus flag-injection
 * protection on the values the author marked with `untrusted()`.
 *
 * Flag protection is per value rather than blanket because it works by
 * refusing leading dashes: applied to the whole argv it turns the author's
 * own `--oneline` into `oneline`.
 *
 * @internal
 */
export async function sanitiseArgs(
  args: readonly ShellArg[],
): Promise<string[]> {
  const { Shescape } = await loadShescape();
  // Two instances rather than one, because flag protection is the setting
  // that differs between a literal the author wrote and a value that came
  // from outside, and it is fixed at construction.
  const literal = new Shescape({ shell: false, flagProtection: false });
  const external = new Shescape({ shell: false, flagProtection: true });

  return args.map((arg, index) => {
    if (isUntrusted(arg)) return external.escape(arg.value);
    if (typeof arg !== "string") {
      throw rcError("RC5003", undefined, {
        message:
          `shell(): argument ${index} is ${arg === null ? "null" : typeof arg}, not a string. ` +
          `Pass a string, or wrap a value from the exchange in untrusted() so it is stringified and flag-protected.`,
      });
    }
    return literal.escape(arg);
  });
}

/**
 * Collect a stream into a bounded string, keeping the head and the tail.
 *
 * Truncating to the head alone is the wrong half to keep: on a build log
 * or a failing test run the explanation is at the end. Memory stays bounded
 * by the limit regardless of how much the command writes, which is the
 * other half of why capture is not simply unbounded.
 *
 * @internal
 */
export class BoundedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Uint8Array[] = [];
  private readonly tail: Uint8Array[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private dropped = 0;

  constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  /**
   * Accepts either shape a runner may hand over. The adapter asks for
   * binary chunks so the byte limit means bytes, but a decoded string is
   * coerced rather than refused: a throw from inside a stream handler
   * leaves the awaited subprocess unsettled, which is a hung route rather
   * than a failed one.
   */
  push(chunk: Uint8Array | string): void {
    let rest: Uint8Array =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(this.headLimit - this.headBytes, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;

    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailLimit) {
      const oldest = this.tail[0]!;
      const excess = this.tailBytes - this.tailLimit;
      if (oldest.length <= excess) {
        this.tail.shift();
        this.tailBytes -= oldest.length;
        this.dropped += oldest.length;
      } else {
        this.tail[0] = oldest.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  /**
   * Decode what was kept. A multi-byte character split across the
   * truncation boundary decodes to a replacement character; the marker
   * makes clear that the text is not contiguous anyway.
   */
  result(): { text: string; truncated: boolean } {
    if (this.dropped === 0) {
      return {
        text: Buffer.concat(this.head).toString("utf8"),
        truncated: false,
      };
    }
    const marker = `\n... ${this.dropped} bytes truncated ...\n`;
    return {
      text:
        Buffer.concat(this.head).toString("utf8") +
        marker +
        Buffer.concat(this.tail).toString("utf8"),
      truncated: true,
    };
  }
}

/**
 * Exit status for a command a signal killed.
 *
 * Node reports no exit code in that case, so the result would otherwise
 * have a hole in it. `128 + signal` is the convention every shell uses for
 * exactly this, and `signal` on the result carries the name regardless, so
 * a caller never has to decode the number to learn what happened.
 *
 * @internal
 */
export function exitCodeForSignal(signal: string | undefined): number {
  if (signal === undefined) return 1;
  const number = (osConstants.signals as Record<string, number | undefined>)[
    signal
  ];
  return number === undefined ? 1 : 128 + number;
}
