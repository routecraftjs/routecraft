import { z } from "zod";
import type { FnHandlerContext } from "../../src/index.ts";

/** The answer shape every suspension fixture advertises. */
export const Approval = z.object({ approved: z.boolean() });

/** The model id the scripted dispatcher answers for. */
export const MODEL = "anthropic:claude-opus-4-7";

/**
 * The canonical suspending fn shared by the suspension suites: asks a human
 * and parks on the answer. One copy, because the suspend contract it
 * exercises is exactly what these suites pin; a drifted twin would let a
 * regression hide in whichever suite kept the stale copy.
 */
export const askFn = {
  description: "Ask a human for approval",
  input: z.object({ question: z.string() }),
  handler: (input: unknown, ctx: FnHandlerContext) =>
    ctx.suspend({
      schema: Approval,
      ttl: "72h",
      question: (input as { question: string }).question,
    }),
};
