import { registerErrorCodes, type RCMeta } from "@routecraft/routecraft";

/**
 * Error codes owned by `@routecraft/ai` under the `AI` namespace.
 *
 * The declaration merge makes the codes valid `rcError()` arguments at
 * compile time; the `registerErrorCodes` call below provides the runtime
 * metadata. Loaded as a side-effect import from this package's index so
 * the codes are registered before any adapter can throw them.
 *
 * Numbering: AI1xxx = agent block subsystem. Formerly core RC5025-RC5027,
 * renumbered when the codes moved into this package.
 */
declare module "@routecraft/routecraft" {
  interface EventDetailsMap {
    /** MCP HTTP transport opened a session. */
    "plugin:mcp:session:created": { sessionId: string };
    /** MCP HTTP transport closed a session. */
    "plugin:mcp:session:closed": { sessionId: string };
    /** MCP HTTP server bound its port. */
    "plugin:mcp:server:listening": { host: string; port: number; path: string };
    /** Tool list assembled and exposed to clients. */
    "plugin:mcp:server:tools:exposed": { tools: string[]; count: number };
    /** Inbound MCP tool call dispatched to a route. */
    "plugin:mcp:tool:called": { tool: string; args: unknown };
    /** MCP tool call completed successfully. */
    "plugin:mcp:tool:completed": { tool: string };
    /** MCP tool call failed. */
    "plugin:mcp:tool:failed": { tool: string; error: string };
  }
  interface ErrorCodeRegistry {
    /** Agent block resolution failed (formerly RC5025) */
    AI1001: RCMeta;
    /** Agent block name collision (formerly RC5026) */
    AI1002: RCMeta;
    /** Agent block misconfigured (formerly RC5027) */
    AI1003: RCMeta;
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
  },
  "@routecraft/ai",
);
