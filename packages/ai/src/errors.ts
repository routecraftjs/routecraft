import { registerErrorCodes, type RCMeta } from "@routecraft/routecraft";

/**
 * Error codes owned by `@routecraft/ai` under the `AI` namespace.
 *
 * The declaration merge makes the codes valid `rcError()` arguments at
 * compile time; the `registerErrorCodes` call below provides the runtime
 * metadata. Loaded as a side-effect import from this package's index so
 * the codes are registered before any adapter can throw them.
 *
 * Numbering: AI1xxx = agent blocks and configuration (formerly core
 * RC5025-RC5027, renumbered when the codes moved into this package),
 * AI2xxx = MCP boundary, AI3xxx = built-in agent tools. Ranges are claimed
 * in the range-allocation table on the error reference page before use, so
 * two lanes landing in parallel cannot mint the same code.
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
    /** MCP HTTP server bound its port. */
    "plugin:mcp:server:listening": { host: string; port: number; path: string };
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
