/**
 * A tool the test holds open, so a turn stays running until released.
 *
 * Built per call rather than shared at module level: bun shares one module
 * registry across the files of a run, and two files holding one `release`
 * would step on each other's turns.
 */

import { z } from "zod";
import type { FnHandlerContext } from "../../src/index.ts";

export interface SlowTool {
  /** The fn to register under `agentPlugin({ functions })`. */
  readonly fn: {
    description: string;
    input: z.ZodObject<Record<string, never>>;
    handler: (input: unknown, ctx: FnHandlerContext) => Promise<string>;
  };
  /** Let the held turn continue. A no-op when nothing is held. */
  release(): void;
  /** Wait until the tool has been entered `count` times. */
  waitForEntry(count: number, ms?: number): Promise<void>;
  /** Forget the held call, for `beforeEach`. */
  reset(): void;
}

export function slowTool(): SlowTool {
  /** Every call still held; released together, so no held turn is stranded. */
  let held: Array<() => void> = [];
  let entered = 0;
  const releaseAll = (): void => {
    const pending = held;
    held = [];
    for (const release of pending) release();
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  return {
    fn: {
      description: "Waits until the test releases it",
      input: z.object({}),
      handler: (_input, ctx) =>
        new Promise<string>((resolve, reject) => {
          entered += 1;
          const abort = (): void => {
            const err = new Error("slow tool aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (ctx.abortSignal.aborted) return abort();
          ctx.abortSignal.addEventListener("abort", abort, { once: true });
          held.push(() => resolve("released"));
        }),
    },
    release: releaseAll,
    async waitForEntry(count, ms = 5_000) {
      const deadline = Date.now() + ms;
      while (entered < count && Date.now() < deadline) await sleep(5);
      if (entered < count) {
        throw new Error(`slow tool entry ${count} never came`);
      }
    },
    reset: () => {
      releaseAll();
      entered = 0;
    },
  };
}
