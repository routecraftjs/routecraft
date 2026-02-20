import { DirectAdapter } from "@routecraft/routecraft";

/**
 * MCP adapter for local direct endpoints.
 * Extends DirectAdapter with MCP semantics; use via mcp(endpoint) with no options
 * for .to(mcp('endpoint')) or when another route defines the endpoint with options.
 */
export class MCPAdapter<T = unknown> extends DirectAdapter<T> {
  constructor(...args: ConstructorParameters<typeof DirectAdapter<T>>) {
    super(...args);
  }
}
