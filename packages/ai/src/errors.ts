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
 * charter widened to runtime with AI1005/AI1006/AI1007, and to the editor
 * surface with AI1013-AI1019), AI2xxx = MCP
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
     * MCP tool call deferred at a durable deferral: execution one answered
     * with the `Deferred` acknowledgment and the real result belongs to
     * execution two. Separate from `completed` because a deferred run
     * reported as finished is a false receipt (the same honesty rule that
     * gives declines their own event).
     *
     * Local routes only: a proxied call cannot defer an exchange of ours.
     */
    "plugin:mcp:tool:deferred": {
      tool: string;
      deferralId: string;
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
    /**
     * An editor opened a connection to the ACP mount and initialized it.
     *
     * `subject` is who the mount's validator admitted, absent on a mount
     * with no wall. `clientName` is what the editor calls itself, which is
     * the only thing that tells two editors on one machine apart.
     */
    "plugin:acp:connection:opened": {
      connectionId: string;
      subject?: string;
      clientName?: string;
    };
    /**
     * An ACP connection closed. Every conversation it held outlives it.
     *
     * `fault` is the transport's reason when the connection broke rather
     * than closed, and absent on a clean close. One event for both, because
     * they are the same lifecycle moment; the field is what tells them apart.
     */
    "plugin:acp:connection:closed": { connectionId: string; fault?: string };
    /**
     * A conversation was opened, loaded or resumed on an ACP connection.
     *
     * `how` says which: `new` minted the id, `load` replayed the transcript
     * onto a fresh connection, `resume` attached without replaying.
     */
    "plugin:acp:session:attached": {
      connectionId: string;
      sessionId: string;
      agentName: string;
      how: "new" | "load" | "resume";
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
    /** Agent deferral unavailable on this surface */
    AI1006: RCMeta;
    /** Agent deferral state invalid at rehydration */
    AI1007: RCMeta;
    /** Deferred agent thread replacement refused */
    AI1008: RCMeta;
    /** Model context window exceeded */
    AI1009: RCMeta;
    /** Agent session record could not be read or written */
    AI1010: RCMeta;
    /** A tool asked to defer an agent session turn */
    AI1011: RCMeta;
    /** The agent session store could not be opened, read or written */
    AI1012: RCMeta;
    /** No editor surface is attached to this exchange */
    AI1013: RCMeta;
    /** The editor surface disconnected before the call could be made */
    AI1014: RCMeta;
    /** The editor never advertised the capability this call needs */
    AI1015: RCMeta;
    /** The editor refused or failed the call */
    AI1016: RCMeta;
    /** A session override names something the agent does not offer */
    AI1017: RCMeta;
    /** The editor answered a surface call with something that is not the protocol's shape */
    AI1018: RCMeta;
    /** A route built a surface update that is not a shape the protocol defines */
    AI1019: RCMeta;
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
      message: "Agent deferral unavailable on this surface",
      suggestion:
        "ctx.defer() was called where no exchange can be durably deferred: a proxied MCP tool guard, a testFn dispatch, or an agent invoked over a synthetic exchange with no route binding. The refusal happens at the call, before anything is written. Dispatch the agent through a route (its exchange is then route-bound and deferrable), or drop the deferral from this handler.",
      docs: `${DOCS_BASE}#ai-1006`,
      retryable: false,
    },
    AI1007: {
      category: "Adapter",
      message: "Agent deferral state invalid at rehydration",
      suggestion:
        "A resumed exchange carried stepState this agent cannot re-enter: the persisted shape is not the { agentId, messages, deferredToolCallId, turnsUsed } record the runtime writes, or it names a different agent than the one the route now dispatches. The deferral was already claimed, so this failure is recorded as its continuation result and reaches the deferred route's error channel. Restore the agent binding the record names, or treat the deferred work as lost and re-ask.",
      docs: `${DOCS_BASE}#ai-1007`,
      retryable: false,
    },
    AI1008: {
      category: "Adapter",
      message: "Deferred agent thread replacement refused",
      suggestion:
        "A rewrite of a deferred run's message thread (compaction is the usual caller) produced a thread the run could not be resumed from: an orphaned tool call or tool result, a duplicate tool-call id, an empty thread, or a thread that dropped the deferred call the approver's answer lands on. The deferred record is left exactly as it was. Fix the rewrite so every tool call keeps its result and the deferred call survives, or leave the thread alone and let the run resume uncompacted.",
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
        "The session store holds the transcript and inbox of every named agent session, one record per session id. Either a stored record is not the shape the runtime writes (the store was edited by hand, or two versions of @routecraft/ai share one store), or a write lost the compare-and-swap repeatedly to another writer. Inspect the record named in the message, or remove it to start the session over.",
      docs: `${DOCS_BASE}#ai-1010`,
      retryable: false,
    },
    AI1011: {
      category: "Adapter",
      message: "A tool asked to defer an agent session turn",
      suggestion:
        "ctx.defer() was called by a tool inside an agent dispatched with session. A session turn stores its transcript when it ends and is revived from the session record, not from a deferred exchange, so there is no continuation for an approval to resume into. Defer from a sessionless agent, or move the approval into a route the agent calls as a tool.",
      docs: `${DOCS_BASE}#ai-1011`,
      retryable: false,
    },
    AI1012: {
      category: "Adapter",
      message: "Agent session store failed",
      suggestion:
        "The store configured by sessions: { store } (the sqlite file at .routecraft/sessions.db by default) could not be opened, migrated, read or written. Check the path and its permissions, that one process at a time holds the file, and under Node that better-sqlite3 is installed; a store that is busy answers this code too, and that call can be retried. Each store also needs its own file: every sqlite store versions itself through one PRAGMA user_version per database, so pointing this one and the deferral store at a single path is refused rather than made to work.",
      docs: `${DOCS_BASE}#ai-1012`,
      retryable: true,
    },
    AI1013: {
      category: "Adapter",
      message: "No editor surface on this exchange",
      suggestion:
        "surface() reaches the editor that is running this turn, and this exchange has none: the route ran from a timer, an HTTP request, a test, or any source that is not an editor holding a live connection. Guard the call with .choice() and take another path when there is no editor, or dispatch this route from a turn that has one.",
      docs: `${DOCS_BASE}#ai-1013`,
      retryable: false,
    },
    AI1014: {
      category: "Adapter",
      message: "The editor surface disconnected mid-turn",
      suggestion:
        "The turn started with an editor attached and the connection was gone by the time the route called it, or went while the call was outstanding, in which case any answer the person gave is lost with it. There is nothing to retry against on this exchange: an editor that reconnects is a new surface, and the request is never re-sent. Either finish the work without asking, or fail and let the person start it again once their editor is back.",
      docs: `${DOCS_BASE}#ai-1014`,
      retryable: false,
    },
    AI1015: {
      category: "Adapter",
      message: "The editor never advertised this capability",
      suggestion:
        "The editor said at initialize which client methods it serves, and this route called one that was not among them. That is a configuration mismatch rather than a bug: the message names the capability and the method. Use an editor that offers it, or branch on the capability before calling.",
      docs: `${DOCS_BASE}#ai-1015`,
      retryable: false,
    },
    AI1016: {
      category: "Adapter",
      message: "The editor refused or failed the call",
      suggestion:
        "The editor answered the call with a JSON-RPC error, or the turn was cancelled: a call outstanding at the cancel is cancelled at the editor, and one made after it is refused here without being sent. The editor's own error is on this error's cause. A person declining a request is a normal outcome and reaches the route this way; handle it with .error() rather than treating it as a fault. Cleanup that must reach the editor after a cancel is registered beforehand with surface.onCancel().",
      docs: `${DOCS_BASE}#ai-1016`,
      retryable: false,
    },
    AI1017: {
      category: "Adapter",
      message: "Session override not offered by the agent",
      suggestion:
        "A conversation asked to run on a model or a thinking level the agent file does not list. Whoever writes the agent decides what may be changed about it, so the value is refused when it is written rather than silently ignored at the next turn. The message names the value and the list; add it to the agent's `model:` or `reasoning:` list if it should be offered.",
      docs: `${DOCS_BASE}#ai-1017`,
      retryable: false,
    },
    AI1018: {
      category: "Adapter",
      message: "The editor's answer did not match the protocol",
      suggestion:
        "surface() checks what the editor answers against the protocol's own schema for the method before a route sees it, and this answer did not conform; the issues are on the error's cause. The editor is a separate program at whatever version of the protocol it implements, so this is a defect or a version mismatch on the editor's side. Handle it with .error() as the route would handle a refusal, and read the cause to see which field was wrong. A permission answer never raises this: one that cannot be trusted reaches the route as the protocol's cancelled outcome instead.",
      docs: `${DOCS_BASE}#ai-1018`,
      retryable: false,
    },
    AI1019: {
      category: "Adapter",
      message: "A surface update did not match the protocol",
      suggestion:
        "surface.notify() checks the update a route built against the protocol's session/update schema before sending it, and this one did not conform; the issues are on the error's cause. Nothing was sent. This is a defect in the route: fix the callback so the update is a shape the protocol defines (the sessionUpdate discriminator and the fields that go with it).",
      docs: `${DOCS_BASE}#ai-1019`,
      retryable: false,
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
