import { registerErrorCodes, type RCMeta } from "@routecraft/routecraft";

/**
 * Error codes owned by `@routecraft/ai` under the `AI` namespace.
 *
 * The declaration merge makes the codes valid `rcError()` arguments at
 * compile time; the `registerErrorCodes` call below provides the runtime
 * metadata. Loaded as a side-effect import from this package's index so
 * the codes are registered before any adapter can throw them.
 *
 * Numbering: AI1xxx = agent block subsystem (formerly core RC5025-RC5027,
 * renumbered when the codes moved into this package). AI2xxx = built-in
 * web tools.
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
  }
  interface ErrorCodeRegistry {
    /** Agent block resolution failed (formerly RC5025) */
    AI1001: RCMeta;
    /** Agent block name collision (formerly RC5026) */
    AI1002: RCMeta;
    /** Agent block misconfigured (formerly RC5027) */
    AI1003: RCMeta;
    /** Web tool refused to dereference a URL */
    AI2001: RCMeta;
    /** Web tool request failed */
    AI2002: RCMeta;
    /** Web tool could not read the fetched content */
    AI2003: RCMeta;
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
      docs: `${DOCS_BASE}#ai1001`,
      retryable: false,
    },
    AI1002: {
      category: "Adapter",
      message: "Agent block name collision",
      suggestion:
        "A block name duplicates another block, collides with a user tool, or starts with the reserved `_block_` prefix used by synthetic loader tools. Rename the block (or the tool) so every name in the agent's surface is unique.",
      docs: `${DOCS_BASE}#ai1002`,
      retryable: false,
    },
    AI1003: {
      category: "Adapter",
      message: "Agent block misconfigured",
      suggestion:
        "A block is missing required fields or has an invalid shape: every block needs a non-empty `name`, a `mode` of `inject` or `progressive`, and a string-or-function `value`. Progressive blocks additionally require a non-empty `description` so the model can decide whether to load them.",
      docs: `${DOCS_BASE}#ai1003`,
      retryable: false,
    },
    AI2001: {
      category: "Adapter",
      message: "Web tool refused to dereference a URL",
      suggestion:
        "The URL was rejected before any connection was made: it used a scheme other than http(s), carried embedded credentials, fell outside the configured `allowedDomains`, or resolved to a non-public address (loopback, private, link-local, or cloud-metadata). Reaching internal hosts through this tool is not supported; expose them as a route or a purpose-built fn instead.",
      docs: `${DOCS_BASE}#ai2001`,
      retryable: false,
    },
    AI2002: {
      category: "Adapter",
      message: "Web tool request failed",
      suggestion:
        "The request was attempted but did not produce a usable response: a transport failure, a non-2xx status, a redirect without a Location, or the per-call deadline elapsing. Check the target URL, and raise `timeoutMs` on the tool factory if the host is legitimately slow.",
      docs: `${DOCS_BASE}#ai2002`,
      retryable: true,
    },
    AI2003: {
      category: "Adapter",
      message: "Web tool could not read the fetched content",
      suggestion:
        "The response arrived but could not be turned into text: an unsupported content type (this tool reads HTML, markdown, and plain text), or a continuation `offset` past the end of the document. Fetch binary or API content with a purpose-built route rather than this tool.",
      docs: `${DOCS_BASE}#ai2003`,
      retryable: false,
    },
  },
  "@routecraft/ai",
);
