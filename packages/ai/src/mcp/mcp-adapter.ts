import { DirectAdapter } from "@routecraft/routecraft";
import { BRAND } from "../brand.ts";

/**
 * MCP adapter for local direct endpoints.
 * Extends DirectAdapter with MCP semantics; use via mcp(endpoint) with no options
 * for .to(mcp('endpoint')) or when another route defines the endpoint with options.
 */
export class MCPAdapter<T = unknown> extends DirectAdapter<T> {
  override readonly adapterId = "routecraft.adapter.mcp.direct";

  constructor(...args: ConstructorParameters<typeof DirectAdapter<T>>) {
    super(...args);
    (this as unknown as Record<symbol, boolean>)[BRAND.MCPAdapter] = true;
  }
}
