import { registerErrorCodes, type RCMeta } from "@routecraft/routecraft";

/**
 * Error codes owned by `@routecraft/ai` under the `AI` namespace.
 *
 * The declaration merge makes the codes valid `rcError()` arguments at
 * compile time; the `registerErrorCodes` call below provides the runtime
 * metadata. Loaded as a side-effect import from this package's index so
 * the codes are registered before any adapter can throw them.
 *
 * Numbering: AI1xxx = agent blocks, configuration, and runtime (formerly
 * core RC5025-RC5027, renumbered when the codes moved into this package;
 * charter widened to runtime with AI1005/AI1006/AI1007), AI2xxx = MCP
 * boundary, AI3xxx = built-in agent tools. Ranges are claimed in the
 * range-allocation table on the error reference page before use, so two
 * lanes landing in parallel cannot mint the same code.
 */
/**
 * Provenance of an MCP tool-lifecycle event. Modeled as a discriminated
 * union so `proxied: true` guarantees the `serverId` / `remoteTool` of the
 * registered client the call was forwarded to; a local `.from(mcp())` route
 * call omits `proxied` (or sets it false) and carries neither identifier.
 */
type McpToolProvenance =
  | { proxied?: false; serverId?: undefined; remoteTool?: undefined }
  | { proxied: true; serverId: string; remoteTool: string };

declare module "@routecraft/routecraft" {
  interface EventDetailsMap {
    /** Tool list assembled and exposed to clients. */
    "plugin:mcp:server:tools:exposed": { tools: string[]; count: number };
    /**
     * Inbound MCP tool call dispatched to a route, or (when `proxied` is
     * true) forwarded to a registered client identified by `serverId` /
     * `remoteTool`.
     */
    "plugin:mcp:tool:called": {
      tool: string;
      args: unknown;
    } & McpToolProvenance;
    /** MCP tool call completed successfully. */
    "plugin:mcp:tool:completed": { tool: string } & McpToolProvenance;
    /**
     * MCP tool call parked at a durable suspension: execution one answered
     * with the `Suspended` acknowledgment and the real result belongs to
     * execution two. Separate from `completed` because a parked run
     * reported as finished is a false receipt (the same honesty rule that
     * gives declines their own event).
     *
     * Local routes only: a proxied call cannot park an exchange of ours.
     */
    "plugin:mcp:tool:suspended": {
      tool: string;
      suspensionId: string;
    };
    /** MCP tool call failed. */
    "plugin:mcp:tool:failed": {
      tool: string;
      error: string;
    } & McpToolProvenance;
    /**
     * MCP tool call declined: the route ran and dropped the exchange rather
     * than producing a result. Separate from `failed` so a tool that filters
     * does not report ordinary rejections as errors.
     *
     * Local routes only, so it carries no provenance fields: a proxied call
     * has no exchange of ours to drop, and a remote `isError` result is
     * reported as `failed`.
     */
    "plugin:mcp:tool:declined": {
      tool: string;
      reason: string;
    };
  }
  interface ErrorCodeRegistry {
    /** Agent block resolution failed (formerly RC5025) */
    AI1001: RCMeta;
    /** Agent block name collision (formerly RC5026) */
    AI1002: RCMeta;
    /** Agent block misconfigured (formerly RC5027) */
    AI1003: RCMeta;
    /** Skills source could not be resolved */
    AI1004: RCMeta;
    /** Agent run cancelled */
    AI1005: RCMeta;
    /** Agent suspension unavailable on this surface */
    AI1006: RCMeta;
    /** Agent suspension state invalid at rehydration */
    AI1007: RCMeta;
    /** Parked agent thread replacement refused */
    AI1008: RCMeta;
    /** Model context window exceeded */
    AI1009: RCMeta;
    /** Agent session record could not be read or written */
    AI1010: RCMeta;
    /** A tool asked to park an agent session turn */
    AI1011: RCMeta;
    /** The agent session store could not be opened, read or written */
    AI1012: RCMeta;
    /** MCP tool result violated the tool's advertised output schema */
    AI2001: RCMeta;
    /** MCP tool declined the request: the route dropped the exchange */
    AI2002: RCMeta;
  }
}

const DOCS_BASE = "https://routecraft.dev/docs/reference/errors";

registerErrorCodes(
  "AI",
  {
    AI1001: {
      category: "Adapter",
      message: "Agent block resolution failed",
      suggestion:
        "A block resolver threw or returned a non-string. Check the resolver function for the named block; inject-mode failures abort the dispatch, progressive-mode failures surface back to the model as a loader-tool error.",
      docs: `${DOCS_BASE}#ai-1001`,
      retryable: false,
    },
    AI1002: {
      category: "Adapter",
      message: "Agent block name collision",
      suggestion:
        "A block name duplicates another block, collides with a user tool, or starts with the reserved `_block_` prefix used by synthetic loader tools. Rename the block (or the tool) so every name in the agent's surface is unique.",
      docs: `${DOCS_BASE}#ai-1002`,
      retryable: false,
    },
    AI1003: {
      category: "Adapter",
      message: "Agent block misconfigured",
      suggestion:
        "A block is missing required fields or has an invalid shape: every block needs a non-empty `name`, a `mode` of `inject` or `progressive`, and a string-or-function `value`. Progressive blocks additionally require a non-empty `description` so the model can decide whether to load them.",
      docs: `${DOCS_BASE}#ai-1003`,
      retryable: false,
    },
    AI1004: {
      category: "Adapter",
      message: "Skills source could not be resolved",
      suggestion:
        "A `skills:` ref in agent frontmatter did not resolve to a directory. A local ref is relative to the agent file; an `npm:` ref resolves against installed packages, so check the package is a dependency of the project and that the subpath exists inside it.",
      docs: `${DOCS_BASE}#ai-1004`,
      retryable: false,
    },
    AI1005: {
      category: "Adapter",
      message: "Agent run cancelled",
      suggestion:
        "The run's abort signal fired (a route stop, an elapsed .timeout(), or context shutdown) and the agent loop stopped cooperatively instead of finishing the turn and discarding it. The error's cause carries the turns completed and the token usage accumulated before the abort, so cost accounting stays honest. Cancellation is terminal; re-dispatch the work as a new exchange if it should run again.",
      docs: `${DOCS_BASE}#ai-1005`,
      retryable: false,
    },
    AI1006: {
      category: "Adapter",
      message: "Agent suspension unavailable on this surface",
      suggestion:
        "ctx.suspend() was called where no exchange can be durably parked: a proxied MCP tool guard, a testFn dispatch, or an agent invoked over a synthetic exchange with no route binding. The refusal happens at the call, before anything is written. Dispatch the agent through a route (its exchange is then route-bound and parkable), or drop the suspension from this handler.",
      docs: `${DOCS_BASE}#ai-1006`,
      retryable: false,
    },
    AI1007: {
      category: "Adapter",
      message: "Agent suspension state invalid at rehydration",
      suggestion:
        "A resumed exchange carried stepState this agent cannot re-enter: the persisted shape is not the { agentId, messages, suspendedToolCallId, turnsUsed } record the runtime writes, or it names a different agent than the one the route now dispatches. The suspension was already claimed, so this failure is recorded as its terminal outcome and reaches the suspended route's error channel. Restore the agent binding the record names, or treat the parked work as lost and re-ask.",
      docs: `${DOCS_BASE}#ai-1007`,
      retryable: false,
    },
    AI1008: {
      category: "Adapter",
      message: "Parked agent thread replacement refused",
      suggestion:
        "A rewrite of a parked run's message thread (compaction is the usual caller) produced a thread the run could not be resumed from: an orphaned tool call or tool result, a duplicate tool-call id, an empty thread, or a thread that dropped the suspended call the approver's answer lands on. The parked record is left exactly as it was. Fix the rewrite so every tool call keeps its result and the suspended call survives, or leave the thread alone and let the run resume uncompacted.",
      docs: `${DOCS_BASE}#ai-1008`,
      retryable: false,
    },
    AI1009: {
      category: "Adapter",
      message: "Model context window exceeded",
      suggestion:
        "The provider refused the request because the prompt does not fit the model's context window. This is distinct from an ordinary dispatch failure: no retry of the same input can succeed, and the fix is to send less. Compact the conversation, trim the tool results carried in the thread, or move to a model with a larger window. The provider's own refusal is on the error's cause.",
      docs: `${DOCS_BASE}#ai-1009`,
      retryable: false,
    },
    AI1010: {
      category: "Adapter",
      message: "Agent session record could not be read or written",
      suggestion:
        "The suspension store holds the transcript and inbox of every named agent session, one record per (agent, session). Either a stored record is not the shape the runtime writes (the store was edited by hand, or two versions of @routecraft/ai share one store), or a write lost the compare-and-swap repeatedly to another writer. Inspect the record named in the message, or remove it to start the session over.",
      docs: `${DOCS_BASE}#ai-1010`,
      retryable: false,
    },
    AI1011: {
      category: "Adapter",
      message: "A tool asked to park an agent session turn",
      suggestion:
        "ctx.suspend() was called by a tool inside an agent dispatched with session. A session turn stores its transcript when it ends and is revived from the session record, not from a parked exchange, so there is no continuation for an approval to resume into. Park from a sessionless agent, or move the approval into a route the agent calls as a tool.",
      docs: `${DOCS_BASE}#ai-1011`,
      retryable: false,
    },
    AI1012: {
      category: "Adapter",
      message: "Agent session store failed",
      suggestion:
        "The store configured by sessions: { store } (the sqlite file at .routecraft/sessions.db by default) could not be opened, migrated, read or written. Check the path and its permissions, that one process at a time holds the file, and under Node that better-sqlite3 is installed; a store that is busy answers this code too, and that call can be retried.",
      docs: `${DOCS_BASE}#ai-1012`,
      retryable: true,
    },
    AI2001: {
      category: "Adapter",
      message: "MCP tool output violated its declared schema",
      suggestion:
        "The route behind this tool declares `.output()`, which the MCP server advertises as the tool's `outputSchema`, and the body it returned does not satisfy it. Fix the route so its result matches the declared shape, or widen `.output()` to describe what the route actually returns. The failing fields are in the error cause.",
      docs: `${DOCS_BASE}#ai-2001`,
      retryable: false,
    },
    AI2002: {
      category: "Adapter",
      message: "MCP tool declined the request",
      suggestion:
        "The route behind this tool dropped the exchange instead of completing it (a `.filter()` rejected it, a `.choice()` matched no branch, or an error handler returned `recovery.drop()`), so there is no result to return. Give the route a branch that produces a result the caller can use (an empty list, an explicit not-found shape) if the caller should receive a value. Mirrors RC5031 on the direct and forward surfaces.",
      docs: `${DOCS_BASE}#ai-2002`,
      retryable: false,
    },
  },
  "@routecraft/ai",
);
