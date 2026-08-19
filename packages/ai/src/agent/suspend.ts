import type { Duration } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Cross-instance brand for {@link AgentSuspendSentinel}, `Symbol.for`-keyed
 * so duplicate copies of this package in one process agree on it.
 *
 * @internal
 */
const SUSPEND_SENTINEL_BRAND = Symbol.for("routecraft.ai.agentSuspendSentinel");

/**
 * What a fn handler passes to `ctx.suspend()`: the same pieces the core
 * `.suspend({ expect, ttl })` operation declares, plus the two human-facing
 * fields the `Suspended` acknowledgment reserves for exactly this producer.
 */
export interface AgentSuspendOptions {
  /**
   * What a valid answer looks like. Rendered onto the `Suspended`
   * acknowledgment (so the answerer can see the shape) and folded into the
   * suspension's compatibility hash.
   *
   * Descriptive at resume time, unlike the core operation's `expect`: the
   * live schema exists only in this handler's code, so after a restart the
   * framework cannot re-validate against it and the answer reaches the
   * model as an ordinary, untrusted tool result. Treat it accordingly.
   */
  expect: StandardSchemaV1;
  /**
   * How long the suspension stays resumable (e.g. `"72h"`). Omitted means
   * the context's `defaultTtl`. Expiry re-enters the route's error channel
   * with `RC5047`, exactly as with the core operation.
   */
  ttl?: Duration;
  /** Human-facing question, surfaced on `Suspended.question`. */
  question?: string;
  /** Machine-facing reason, surfaced on `Suspended.reason`. */
  reason?: string;
}

/**
 * The value `ctx.suspend()` returns and a suspending handler returns to the
 * runtime. Opaque by convention: return it as-is, immediately. The type is
 * structural (so test harnesses can produce a compatible shape without
 * depending on this package), and the runtime check is the brand the
 * factory applies.
 */
export interface AgentSuspendSentinel {
  readonly status: "suspend-requested";
  /** What the handler asked for. Read by the agent runtime at the park. */
  readonly request: AgentSuspendOptions;
}

/**
 * Mint the sentinel `ctx.suspend()` hands back. Branded so the tool bridge
 * recognises it without shape-sniffing a result a tool could also produce.
 *
 * @internal
 */
export function createSuspendSentinel(
  request: AgentSuspendOptions,
): AgentSuspendSentinel {
  const sentinel: AgentSuspendSentinel = {
    status: "suspend-requested",
    request,
  };
  (sentinel as unknown as Record<symbol, boolean>)[SUSPEND_SENTINEL_BRAND] =
    true;
  return sentinel;
}

/**
 * Whether a tool handler's return value is the `ctx.suspend()` sentinel.
 *
 * @internal
 */
export function isSuspendSentinel(
  value: unknown,
): value is AgentSuspendSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SUSPEND_SENTINEL_BRAND] === true
  );
}

/**
 * Accept-anything Standard Schema used as the `expect` when a handler
 * suspends through the {@link SuspendError} escape hatch without declaring
 * one. The acknowledgment then carries an open JSON Schema, honestly
 * telling the answerer any JSON is accepted.
 *
 * @internal
 */
export const anyAnswerSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate: (value) => ({ value }),
    // Non-standard extension the JSON Schema conversion sites look up
    // defensively; an empty schema accepts any JSON value.
    jsonSchema: { input: () => ({}), output: () => ({}) },
  } as StandardSchemaV1<unknown, unknown>["~standard"],
};

/**
 * Escape-hatch signal: throw from a fn handler to suspend the agent's tool
 * loop when returning is impossible (the suspension decision is made deep
 * inside a call stack that cannot thread a return value out).
 *
 * **Prefer `ctx.suspend()`**, which is the documented path. Control flow
 * through exceptions has a footgun this class cannot remove: a handler that
 * wraps its work in `try/catch` will silently swallow a thrown suspension
 * and carry on, handing the model a garbage tool result instead of parking
 * the run. The sentinel return cannot be swallowed that way.
 *
 * Outside an agent dispatch (a proxied MCP tool guard, `testFn`), throwing
 * this behaves like any other error.
 *
 * @example
 * ```ts
 * import { SuspendError } from "@routecraft/ai"
 *
 * const askApproval: FnOptions = {
 *   description: "Ask a human for approval via email",
 *   input: z.object({ question: z.string() }),
 *   handler: async (input, ctx) => {
 *     await sendApprovalRequest({ question: input.question, ctx })
 *     throw new SuspendError({ expect: Approval, ttl: "72h", question: input.question })
 *   },
 * }
 * ```
 */
export class SuspendError extends Error {
  /** Discriminator for runtime detection. */
  override readonly name = "SuspendError";
  /**
   * What a valid answer looks like. Optional on the escape hatch (unlike
   * `ctx.suspend()`, where it is required): when absent, the suspension
   * accepts any JSON answer and advertises an open schema.
   */
  readonly expect?: StandardSchemaV1;
  /** How long the suspension stays resumable. Omitted means the context default. */
  readonly ttl?: Duration;
  /** Human-facing question, surfaced on `Suspended.question`. */
  readonly question?: string;
  /**
   * Machine-facing reason, surfaced on `Suspended.reason`. Free-form; pick
   * whatever your product vocabulary uses ("awaiting-human-approval",
   * "waiting-for-webhook", etc.).
   */
  readonly reason?: string;
  /**
   * Optional channel hint indicating how the agent will be resumed.
   * Surfaces in telemetry only; the durable record does not carry it.
   */
  readonly resumeChannel?: string;

  constructor(opts?: {
    expect?: StandardSchemaV1;
    ttl?: Duration;
    question?: string;
    reason?: string;
    resumeChannel?: string;
  }) {
    super(
      opts?.reason
        ? `Agent suspended: ${opts.reason}`
        : "Agent suspended pending external resumption.",
    );
    if (opts?.expect !== undefined) this.expect = opts.expect;
    if (opts?.ttl !== undefined) this.ttl = opts.ttl;
    if (opts?.question !== undefined) this.question = opts.question;
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
