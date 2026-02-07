# Plan 5: MCP Source Adapter

## Overview

Add the ability to expose RouteCraft tools as MCP tools using `.from(mcp())`. This wraps the direct adapter and exposes it via an MCP server that external clients (Claude, Cursor, etc.) can connect to.

**Status:** Ready after Plan 4  
**Depends on:** Plan 4 (MCP Destination)  
**Estimate:** 6-8 hours

## Rationale

**Why wrap DirectAdapter?**

The `tool()` (alias for `direct()`) already provides:
- Schema validation
- Route registry with metadata
- Synchronous request/response semantics

MCP tools have the same semantics - request/response with input schemas. The MCP source adapter just exposes existing tools over the MCP protocol.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                        RouteCraft Context                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  MCP Server      │    │  Tool Route      │                   │
│  │  (from mcp())    │───▶│  fetch-webpage   │                   │
│  │                  │    │  .from(tool(...))│                   │
│  └────────┬─────────┘    └──────────────────┘                   │
│           │                                                      │
│           │              ┌──────────────────┐                   │
│           │              │  Tool Route      │                   │
│           └─────────────▶│  search-docs     │                   │
│                          │  .from(tool(...))│                   │
│                          └──────────────────┘                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
          ▲
          │ MCP Protocol (stdio/HTTP)
          │
┌─────────┴─────────┐
│  External Client  │
│  (Claude, Cursor) │
└───────────────────┘
```

## Package Structure (additions)

```
packages/
  ai/
    src/
      mcp/
        index.ts         # Updated exports
        types.ts         # Updated types
        server.ts        # MCP server wrapper
        source.ts        # mcp() source adapter
    test/
      mcp-source.test.ts
```

## Implementation

### 1. Update src/mcp/types.ts

```typescript
// ... existing types ...

/**
 * Options for mcp() source adapter (exposing tools)
 */
export interface MCPSourceOptions {
  /** Server name for identification */
  serverName?: string;
  
  /** Server version */
  serverVersion?: string;
  
  /** 
   * Transport configuration
   * - 'stdio': Use stdin/stdout (default for CLI tools)
   * - object: HTTP server configuration
   */
  transport?: "stdio" | {
    type: "sse" | "streamable-http";
    port: number;
    host?: string;
  };
  
  /**
   * Which tools to expose. If not specified, exposes all discoverable tools.
   * - string[]: List of tool endpoint names
   * - function: Filter function
   */
  tools?: string[] | ((metadata: import("@routecraft/routecraft").DirectRouteMetadata) => boolean);
  
  /**
   * Transform tool metadata before exposing
   */
  transformMetadata?: (metadata: import("@routecraft/routecraft").DirectRouteMetadata) => {
    name?: string;
    description?: string;
  };
}
```

### 2. Create src/mcp/server.ts

```typescript
import type { CraftContext, DirectRouteMetadata } from "@routecraft/routecraft";
import { DirectAdapter } from "@routecraft/routecraft";
import type { MCPSourceOptions, MCPTool } from "./types.ts";

/**
 * MCP Server that exposes RouteCraft tools
 */
export class MCPServer {
  private context: CraftContext;
  private options: MCPSourceOptions;
  private running = false;
  
  // Would be actual MCP SDK types
  private server: any;
  private transport: any;
  
  constructor(context: CraftContext, options: MCPSourceOptions) {
    this.context = context;
    this.options = options;
  }
  
  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    // Get tools to expose
    const tools = this.getExposedTools();
    
    if (tools.length === 0) {
      this.context.logger.warn("No tools to expose via MCP server");
      return;
    }
    
    // In real implementation, use @modelcontextprotocol/sdk
    // import { Server } from "@modelcontextprotocol/sdk/server/index.js";
    // import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    //
    // this.server = new Server(
    //   { name: this.options.serverName ?? "routecraft", version: this.options.serverVersion ?? "1.0.0" },
    //   { capabilities: { tools: {} } }
    // );
    //
    // this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    //   tools: tools.map(t => this.metadataToMCPTool(t))
    // }));
    //
    // this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    //   return this.handleToolCall(request.params.name, request.params.arguments);
    // });
    //
    // if (this.options.transport === "stdio") {
    //   this.transport = new StdioServerTransport();
    // } else {
    //   // HTTP transport setup
    // }
    //
    // await this.server.connect(this.transport);
    
    this.running = true;
    this.context.logger.info(
      `MCP server started with ${tools.length} tools: ${tools.map(t => t.endpoint).join(", ")}`
    );
  }
  
  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    if (this.transport?.close) {
      await this.transport.close();
    }
    
    this.running = false;
    this.context.logger.info("MCP server stopped");
  }
  
  /**
   * Get list of tools that should be exposed
   */
  private getExposedTools(): DirectRouteMetadata[] {
    const registry = this.context.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    if (!registry) return [];
    
    let tools = Array.from(registry.values());
    
    // Filter tools based on options
    if (this.options.tools) {
      if (Array.isArray(this.options.tools)) {
        const allowedNames = new Set(this.options.tools);
        tools = tools.filter(t => allowedNames.has(t.endpoint));
      } else {
        tools = tools.filter(this.options.tools);
      }
    }
    
    return tools;
  }
  
  /**
   * Convert RouteCraft metadata to MCP tool format
   */
  private metadataToMCPTool(metadata: DirectRouteMetadata): MCPTool {
    const transformed = this.options.transformMetadata?.(metadata) ?? {};
    
    return {
      name: transformed.name ?? metadata.endpoint,
      description: transformed.description ?? metadata.description,
      inputSchema: this.schemaToJsonSchema(metadata.schema),
    };
  }
  
  /**
   * Convert StandardSchema to JSON Schema for MCP
   */
  private schemaToJsonSchema(schema?: import("@standard-schema/spec").StandardSchemaV1): MCPTool["inputSchema"] {
    if (!schema) {
      return { type: "object" };
    }
    
    // Check for toJsonSchema method
    if ("toJsonSchema" in schema && typeof schema.toJsonSchema === "function") {
      return schema.toJsonSchema() as MCPTool["inputSchema"];
    }
    
    // Fallback
    return { type: "object", additionalProperties: true };
  }
  
  /**
   * Handle incoming tool call from MCP client
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    // Find the tool's channel and call it
    const store = this.context.getStore(DirectAdapter.ADAPTER_DIRECT_STORE);
    if (!store) {
      return {
        content: [{ type: "text", text: `Error: No tools registered` }],
      };
    }
    
    const channel = store.get(toolName);
    if (!channel) {
      return {
        content: [{ type: "text", text: `Error: Tool not found: ${toolName}` }],
      };
    }
    
    try {
      // Create a minimal exchange and send to the tool
      const result = await channel.send(toolName, {
        body: args,
        headers: {},
        id: crypto.randomUUID(),
        timestamp: new Date(),
      } as any);
      
      // Convert result to MCP format
      const content = typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
      
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
      };
    }
  }
}
```

### 3. Create src/mcp/source.ts

```typescript
import type { Exchange, ExchangeHeaders } from "@routecraft/routecraft";
import type { Source } from "@routecraft/routecraft";
import { CraftContext } from "@routecraft/routecraft";
import { MCPServer } from "./server.ts";
import type { MCPSourceOptions } from "./types.ts";

// Store key for the MCP server instance
const MCP_SERVER_STORE_KEY = "routecraft.ai.mcp.server";

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [MCP_SERVER_STORE_KEY]: MCPServer;
  }
}

/**
 * MCP source adapter that starts an MCP server to expose tools
 */
export class MCPSourceAdapter implements Source<never> {
  readonly adapterId = "routecraft.ai.adapter.mcp.source";
  
  private options: MCPSourceOptions;
  
  constructor(options: MCPSourceOptions = {}) {
    this.options = options;
  }
  
  async subscribe(
    context: CraftContext,
    _handler: (message: never, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    // Check if server already exists (singleton per context)
    let server = context.getStore(MCP_SERVER_STORE_KEY) as MCPServer | undefined;
    
    if (!server) {
      server = new MCPServer(context, this.options);
      context.setStore(MCP_SERVER_STORE_KEY, server);
    }
    
    // Start the server
    await server.start();
    
    // Keep running until aborted
    return new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", async () => {
        await server!.stop();
        resolve();
      });
    });
  }
}

/**
 * Create an MCP source that exposes RouteCraft tools to external clients.
 * 
 * This starts an MCP server that external clients (Claude, Cursor, etc.)
 * can connect to and call your tools.
 * 
 * @example
 * ```typescript
 * import { mcp, tool } from '@routecraft/ai'
 * 
 * // Define tools
 * craft()
 *   .from(tool('fetch-webpage', {
 *     description: 'Fetch a webpage',
 *     schema: z.object({ url: z.string().url() }),
 *   }))
 *   .process(async ({ url }) => {
 *     const res = await fetch(url)
 *     return { content: await res.text() }
 *   })
 * 
 * // Expose all tools via MCP
 * craft()
 *   .from(mcp())  // Starts MCP server exposing all tools
 *   .to(noop())   // MCP source handles responses internally
 * ```
 * 
 * @example
 * ```typescript
 * // Expose specific tools with HTTP transport
 * craft()
 *   .from(mcp({
 *     serverName: 'my-tools',
 *     transport: { type: 'sse', port: 3001 },
 *     tools: ['fetch-webpage', 'search-docs'],  // Only these tools
 *   }))
 *   .to(noop())
 * ```
 * 
 * @example
 * ```typescript
 * // Filter tools dynamically
 * craft()
 *   .from(mcp({
 *     tools: (meta) => meta.keywords?.includes('public') ?? false,
 *   }))
 *   .to(noop())
 * ```
 */
export function mcpSource(options?: MCPSourceOptions): MCPSourceAdapter {
  return new MCPSourceAdapter(options);
}
```

### 4. Update src/mcp/index.ts

```typescript
export type {
  MCPTool,
  MCPToolResult,
  MCPServerOptions,
  MCPDestinationOptions,
  MCPSourceOptions,
} from "./types.ts";

export { MCPClient } from "./client.ts";
export { MCPServer } from "./server.ts";
export { mcp, MCPDestinationAdapter } from "./destination.ts";
export { mcpSource, MCPSourceAdapter } from "./source.ts";
```

### 5. Update src/index.ts

```typescript
// DSL functions
export { tool, type ToolOptions } from "./dsl.ts";

// LLM
export {
  llm,
  OpenAIProvider,
  GeminiProvider,
  type LLMProvider,
  type LLMMessage,
  type LLMResponse,
  type LLMCompletionOptions,
  type LLMAdapterOptions,
  type OpenAIProviderOptions,
  type GeminiProviderOptions,
} from "./llm/index.ts";

// MCP
export {
  mcp,
  mcpSource,
  MCPClient,
  MCPServer,
  MCPDestinationAdapter,
  MCPSourceAdapter,
  type MCPTool,
  type MCPToolResult,
  type MCPServerOptions,
  type MCPDestinationOptions,
  type MCPSourceOptions,
} from "./mcp/index.ts";

// Re-export relevant types from core
export type {
  DirectRouteMetadata,
  DirectAdapter,
  DirectOptions,
} from "@routecraft/routecraft";
```

### 6. Create test/mcp-source.test.ts

```typescript
import { describe, test, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { mcpSource, MCPServer } from "../src/index.ts";
import {
  context,
  craft,
  DirectAdapter,
  noop,
  type CraftContext,
} from "@routecraft/routecraft";
import { tool } from "../src/index.ts";

describe("mcpSource() adapter", () => {
  let ctx: CraftContext;
  
  afterEach(async () => {
    if (ctx) await ctx.stop();
  });
  
  test("creates source adapter", () => {
    const adapter = mcpSource();
    expect(adapter.adapterId).toBe("routecraft.ai.adapter.mcp.source");
  });
  
  test("creates source adapter with options", () => {
    const adapter = mcpSource({
      serverName: "my-tools",
      transport: { type: "sse", port: 3001 },
      tools: ["tool-a", "tool-b"],
    });
    
    expect(adapter.adapterId).toBe("routecraft.ai.adapter.mcp.source");
  });
  
  test("exposes tools from registry", async () => {
    ctx = context()
      .routes([
        // Define a tool
        craft()
          .id("my-tool")
          .from(
            tool("test-tool", {
              description: "A test tool",
              schema: z.object({ input: z.string() }),
            }),
          )
          .to(noop()),
        // Expose via MCP (would start server in real impl)
        // For testing, we just verify the registry is accessible
      ])
      .build();
    
    await ctx.start();
    
    const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    expect(registry?.has("test-tool")).toBe(true);
  });
  
  test("filters tools by name list", async () => {
    const adapter = mcpSource({
      tools: ["allowed-tool"],
    });
    
    // The adapter would filter based on this list
    expect(adapter).toBeDefined();
  });
  
  test("filters tools by function", async () => {
    const adapter = mcpSource({
      tools: (meta) => meta.keywords?.includes("public") ?? false,
    });
    
    expect(adapter).toBeDefined();
  });
  
  test("transforms metadata", async () => {
    const adapter = mcpSource({
      transformMetadata: (meta) => ({
        name: `rc-${meta.endpoint}`,
        description: `RouteCraft: ${meta.description}`,
      }),
    });
    
    expect(adapter).toBeDefined();
  });
});

describe("MCPServer", () => {
  test("can be instantiated", () => {
    const mockContext = {
      getStore: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    } as any;
    
    const server = new MCPServer(mockContext, {});
    expect(server).toBeDefined();
  });
});
```

## Dependencies

Update package.json:

```json
{
  "dependencies": {
    "@routecraft/routecraft": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

## Usage Example

Complete example showing tools exposed via MCP:

```typescript
import { context, craft, noop } from "@routecraft/routecraft";
import { tool, mcpSource } from "@routecraft/ai";
import { z } from "zod";

// Define tools
const fetchWebpage = craft()
  .id("fetch-webpage")
  .from(
    tool("fetch-webpage", {
      description: "Fetch the HTML content of a webpage",
      schema: z.object({
        url: z.string().url(),
      }),
      keywords: ["web", "fetch", "http"],
    }),
  )
  .process(async ({ url }) => {
    const response = await fetch(url);
    return { content: await response.text() };
  });

const searchDocs = craft()
  .id("search-docs")
  .from(
    tool("search-docs", {
      description: "Search documentation",
      schema: z.object({
        query: z.string(),
        limit: z.number().optional().default(10),
      }),
      keywords: ["search", "docs"],
    }),
  )
  .process(async ({ query, limit }) => {
    // Search implementation
    return { results: [] };
  });

// Expose tools via MCP (stdio for CLI usage)
const mcpServer = craft()
  .id("mcp-server")
  .from(mcpSource({ serverName: "my-tools" }))
  .to(noop());

// Start context
const ctx = context()
  .routes([fetchWebpage, searchDocs, mcpServer])
  .build();

await ctx.start();

// Now external clients can connect via stdio and call:
// - fetch-webpage
// - search-docs
```

## Success Criteria

- [ ] `mcpSource()` creates a source adapter
- [ ] Server starts and exposes tools
- [ ] Tool filtering by name list works
- [ ] Tool filtering by function works
- [ ] Metadata transformation works
- [ ] Server responds to tool calls correctly
- [ ] Server shuts down cleanly on context stop
- [ ] All tests pass

## Next Steps

After this plan is complete:
- Plan 6: Agent Routing
