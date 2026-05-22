/**
 * Signal raised by a fn handler when it cannot complete synchronously
 * and the agent's tool-loop should pause until an external event (a
 * human reply, a webhook, a long-running batch result) supplies the
 * answer.
 *
 * **Stub today.** This type is exported so user code that wants to be
 * forward-compatible with the durable-agents epic can throw it, but no
 * runtime path catches it yet. When the durable epic lands, the agent
 * runtime will catch this error, persist the message thread, and
 * return `{ status: "suspended", checkpointId }` to the calling route
 * instead of an `AgentResult`. See the durable-agents tracking issue
 * for the full design.
 *
 * Until then, throwing this is a normal error and behaves like any
 * other tool failure (feeds back to the model for self-correction).
 *
 * For human-in-the-loop flows where waits are short (seconds to
 * minutes), the recommended pattern is to write a tool handler that
 * blocks on the answer (`await pollUntilReply(...)`); the agent's
 * await chain holds the loop in memory until the tool resolves.
 *
 * @experimental
 *
 * @example
 * ```ts
 * import { SuspendError } from "@routecraft/ai"
 *
 * const askApproval: FnOptions = {
 *   description: "Ask a human for approval via email",
 *   input: z.object({ question: z.string() }),
 *   handler: async (input, ctx) => {
 *     await sendApprovalRequest({
 *       question: input.question,
 *       callbackUrl: `${baseUrl}/resume/${ctx.checkpointId}`,
 *     })
 *     throw new SuspendError({ reason: "awaiting-human-approval" })
 *   },
 * }
 * ```
 */
export class SuspendError extends Error {
  /** Discriminator for runtime detection. */
  override readonly name = "SuspendError";
  /**
   * Optional reason string surfaced in telemetry and the eventual
   * suspended-agent record. Free-form; pick whatever your product
   * vocabulary uses ("awaiting-human-approval", "waiting-for-webhook",
   * etc.).
   */
  readonly reason?: string;
  /**
   * Optional channel hint indicating how the agent will be resumed.
   * Surfaces in telemetry and lets the surrounding route decide how
   * to react (e.g. return `202 Accepted` to the HTTP client).
   */
  readonly resumeChannel?: string;

  constructor(opts?: { reason?: string; resumeChannel?: string }) {
    super(
      opts?.reason
        ? `Agent suspended: ${opts.reason}`
        : "Agent suspended pending external resumption.",
    );
    if (opts?.reason !== undefined) this.reason = opts.reason;
    if (opts?.resumeChannel !== undefined) {
      this.resumeChannel = opts.resumeChannel;
    }
  }
}

/**
 * Type guard for `SuspendError`. Used by the runtime to detect
 * suspension signals without importing the concrete class everywhere.
 *
 * @internal
 */
export function isSuspendError(value: unknown): value is SuspendError {
  return value instanceof SuspendError;
}
