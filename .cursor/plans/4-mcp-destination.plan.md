# Plan 4: MCP Adapter (Destination & Enrich)

## Overview

Add the ability to call external MCP tools from RouteCraft routes using `.to(mcp())` and `.enrich(mcp())`. This allows routes to use tools exposed by MCP servers (filesystem, GitHub, databases, etc.).

**Status:** Ready after Plan 3  
**Depends on:** Plan 3 (LLM Adapters)  
**Estimate:** 4-6 hours

## Supported Operations

| Operation | Use Case |
|-----------|----------|
| `.to(mcp())` | Call MCP tool, replace body with result |
| `.enrich(mcp())` | Call MCP tool, merge result into body (keep original + add enrichment) |

## Rationale

**Why `.to(mcp())` and `.enrich(mcp())` first, not `.from(mcp())`?**

1. **Simpler implementation**: Calling external tools is request/response - no server setup needed
2. **Immediate value**: Access the entire MCP ecosystem (filesystem, GitHub, Slack, etc.)
3. **No infrastructure**: Just needs an MCP client, not a server
4. **Testing is easier**: Mock the tool call, don't need to set up server/transport
5. **Enrich is powerful**: Read a file, fetch data, then use it in the next step

## Package Structure (additions)

```
packages/
  ai/
    src/
      mcp/
        index.ts         # MCP exports
        types.ts         # MCP types
        client.ts        # MCP client wrapper
        adapter.ts       # mcp() adapter (destination + enricher)
    test/
      mcp-destination.test.ts
      mcp-enrich.test.ts
```

## Implementation

### 1. Create src/mcp/types.ts

```typescript
/**
 * MCP Tool definition
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP Tool call result
 */
export interface MCPToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * MCP Server connection options
 */
export interface MCPServerOptions {
  /** Server name/identifier */
  name: string;
  
  /** Transport type */
  transport: "stdio" | "sse" | "streamable-http";
  
  /** Command to run (for stdio) */
  command?: string;
  
  /** Arguments for command (for stdio) */
  args?: string[];
  
  /** URL for HTTP transports */
  url?: string;
  
  /** Environment variables for subprocess */
  env?: Record<string, string>;
}

/**
 * Options for mcp() adapter (works with both .to() and .enrich())
 */
export interface MCPAdapterOptions {
  /** MCP server to connect to */
  server: MCPServerOptions;
  
  /** Tool name to call (can be dynamic) */
  tool: string | ((body: unknown) => string);
  
  /** 
   * How to map exchange body to tool arguments.
   * - undefined: Use body directly as arguments
   * - function: Custom mapping
   */
  mapArguments?: (body: unknown) => Record<string, unknown>;
  
  /**
   * How to map tool result.
   * - undefined: Use first text content
   * - function: Custom mapping
   */
  mapResult?: (result: MCPToolResult) => unknown;
  
  /**
   * For .enrich(): Key to store the MCP result under.
   * If not specified, result is merged at top level.
   * @example 'fileContent' -> { ...body, fileContent: result }
   */
  enrichKey?: string;
}
```

### 2. Create src/mcp/client.ts

```typescript
import type { MCPServerOptions, MCPTool, MCPToolResult } from "./types.ts";

/**
 * MCP Client wrapper for calling tools on MCP servers
 */
export class MCPClient {
  private serverOptions: MCPServerOptions;
  private connected = false;
  private tools: Map<string, MCPTool> = new Map();
  
  // These would be actual MCP SDK types in real implementation
  private client: any;
  private transport: any;
  
  constructor(serverOptions: MCPServerOptions) {
    this.serverOptions = serverOptions;
  }
  
  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    
    // In real implementation, use @modelcontextprotocol/sdk
    // This is a simplified version showing the pattern
    
    switch (this.serverOptions.transport) {
      case "stdio":
        await this.connectStdio();
        break;
      case "sse":
      case "streamable-http":
        await this.connectHttp();
        break;
      default:
        throw new Error(`Unknown transport: ${this.serverOptions.transport}`);
    }
    
    this.connected = true;
    
    // List available tools
    await this.refreshTools();
  }
  
  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    
    // Cleanup transport
    if (this.transport?.close) {
      await this.transport.close();
    }
    
    this.connected = false;
  }
  
  /**
   * Call a tool on the MCP server
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    if (!this.connected) {
      await this.connect();
    }
    
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(", ")}`);
    }
    
    // In real implementation, use the MCP SDK to call the tool
    // const result = await this.client.callTool({ name: toolName, arguments: args });
    
    // Placeholder for actual implementation
    throw new Error("MCP client not fully implemented - requires @modelcontextprotocol/sdk");
  }
  
  /**
   * Get list of available tools
   */
  getTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }
  
  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
  
  private async connectStdio(): Promise<void> {
    const { command, args, env } = this.serverOptions;
    
    if (!command) {
      throw new Error("stdio transport requires 'command' option");
    }
    
    // In real implementation:
    // import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
    // import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    //
    // this.transport = new StdioClientTransport({ command, args, env });
    // this.client = new Client({ name: "routecraft", version: "1.0.0" }, {});
    // await this.client.connect(this.transport);
  }
  
  private async connectHttp(): Promise<void> {
    const { url } = this.serverOptions;
    
    if (!url) {
      throw new Error("HTTP transport requires 'url' option");
    }
    
    // In real implementation:
    // import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
    // this.transport = new SSEClientTransport(new URL(url));
    // await this.client.connect(this.transport);
  }
  
  private async refreshTools(): Promise<void> {
    // In real implementation:
    // const { tools } = await this.client.listTools();
    // for (const tool of tools) {
    //   this.tools.set(tool.name, tool);
    // }
  }
}
```

### 3. Create src/mcp/adapter.ts

```typescript
import type { Exchange, DefaultExchange } from "@routecraft/routecraft";
import type { Destination, Enricher } from "@routecraft/routecraft";
import { CraftContext } from "@routecraft/routecraft";
import { MCPClient } from "./client.ts";
import type { MCPAdapterOptions, MCPToolResult } from "./types.ts";

/**
 * MCP adapter for calling external MCP tools.
 * Implements both Destination (for .to()) and Enricher (for .enrich()).
 */
export class MCPAdapter<T = unknown> implements Destination<T>, Enricher<T> {
  readonly adapterId = "routecraft.ai.adapter.mcp";
  
  private client: MCPClient | null = null;
  private options: MCPAdapterOptions;
  
  constructor(options: MCPAdapterOptions) {
    this.options = options;
  }
  
  /**
   * Called by .to(mcp()) - replaces body with result
   */
  async send(exchange: Exchange<T>): Promise<void> {
    const result = await this.callMcpTool(exchange);
    (exchange as DefaultExchange<T>).body = result as T;
  }
  
  /**
   * Called by .enrich(mcp()) - merges result into body
   */
  async enrich(exchange: Exchange<T>): Promise<void> {
    const result = await this.callMcpTool(exchange);
    const defaultExchange = exchange as DefaultExchange<T>;
    
    if (this.options.enrichKey) {
      // Store under specific key
      defaultExchange.body = {
        ...(defaultExchange.body as object),
        [this.options.enrichKey]: result,
      } as T;
    } else {
      // Merge at top level (result must be object)
      if (typeof result === "object" && result !== null) {
        defaultExchange.body = {
          ...(defaultExchange.body as object),
          ...result,
        } as T;
      } else {
        // If result is not an object, store under 'mcpResult'
        defaultExchange.body = {
          ...(defaultExchange.body as object),
          mcpResult: result,
        } as T;
      }
    }
  }
  
  /**
   * Core MCP tool call logic shared by send() and enrich()
   */
  private async callMcpTool(exchange: Exchange<T>): Promise<unknown> {
    const defaultExchange = exchange as DefaultExchange<T>;
    
    // Lazy initialization of client
    if (!this.client) {
      this.client = new MCPClient(this.options.server);
      await this.client.connect();
    }
    
    // Resolve tool name (static or dynamic)
    const toolName =
      typeof this.options.tool === "function"
        ? this.options.tool(exchange.body)
        : this.options.tool;
    
    // Map arguments
    const args = this.options.mapArguments
      ? this.options.mapArguments(exchange.body)
      : (exchange.body as Record<string, unknown>);
    
    defaultExchange.logger.debug(
      `Calling MCP tool "${toolName}" on server "${this.options.server.name}"`,
    );
    
    // Call the tool
    const result = await this.client.callTool(toolName, args);
    
    // Check for errors
    if (result.isError) {
      const errorText = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(`MCP tool error: ${errorText}`);
    }
    
    // Map result
    return this.options.mapResult
      ? this.options.mapResult(result)
      : this.extractTextContent(result);
  }
  
  private extractTextContent(result: MCPToolResult): string {
    const textParts = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    
    return textParts.join("\n");
  }
}

/**
 * Create an MCP adapter for calling external tools.
 * Works with both .to() and .enrich().
 * 
 * @example
 * ```typescript
 * import { mcp } from '@routecraft/ai'
 * 
 * // .to() - Replace body with MCP tool result
 * craft()
 *   .from(source)
 *   .to(mcp({
 *     server: {
 *       name: 'filesystem',
 *       transport: 'stdio',
 *       command: 'npx',
 *       args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
 *     },
 *     tool: 'read_file',
 *     mapArguments: (body) => ({ path: body.filePath }),
 *   }))
 * ```
 * 
 * @example
 * ```typescript
 * // .enrich() - Add MCP result to existing body
 * craft()
 *   .from(simple({ docId: 'readme', format: 'markdown' }))
 *   .enrich(mcp({
 *     server: { name: 'filesystem', transport: 'stdio', command: 'mcp-fs' },
 *     tool: 'read_file',
 *     mapArguments: (body) => ({ path: `/docs/${body.docId}.md` }),
 *     enrichKey: 'fileContent',  // Result stored under 'fileContent'
 *   }))
 *   .process(({ docId, format, fileContent }) => {
 *     // Now we have both the original body AND the file content
 *     return summarize(fileContent)
 *   })
 * ```
 * 
 * @example
 * ```typescript
 * // .enrich() without enrichKey - merge result at top level
 * craft()
 *   .from(simple({ userId: '123' }))
 *   .enrich(mcp({
 *     server: { name: 'api', transport: 'stdio', command: 'mcp-api' },
 *     tool: 'get_user',
 *     mapArguments: (body) => ({ id: body.userId }),
 *     // Result { name: 'John', email: '...' } merged into body
 *   }))
 *   .process(({ userId, name, email }) => {
 *     // Body now has userId + name + email
 *   })
 * ```
 * 
 * @example
 * ```typescript
 * // Dynamic tool selection
 * craft()
 *   .from(source)
 *   .to(mcp({
 *     server: { name: 'github', transport: 'stdio', command: 'mcp-github' },
 *     tool: (body) => body.action, // 'create_issue', 'list_repos', etc.
 *   }))
 * ```
 */
export function mcp<T = unknown>(
  options: MCPAdapterOptions,
): MCPAdapter<T> {
  return new MCPAdapter<T>(options);
}
```

### 4. Create src/mcp/index.ts

```typescript
export type {
  MCPTool,
  MCPToolResult,
  MCPServerOptions,
  MCPAdapterOptions,
} from "./types.ts";

export { MCPClient } from "./client.ts";
export { mcp, MCPAdapter } from "./adapter.ts";
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
  MCPClient,
  MCPAdapter,
  type MCPTool,
  type MCPToolResult,
  type MCPServerOptions,
  type MCPAdapterOptions,
} from "./mcp/index.ts";

// Re-export relevant types from core
export type {
  DirectRouteMetadata,
  DirectAdapter,
  DirectOptions,
} from "@routecraft/routecraft";
```

### 6. Create test/mcp-destination.test.ts

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mcp, MCPClient } from "../src/index.ts";
import type { MCPToolResult } from "../src/index.ts";

// Mock MCPClient
vi.mock("../src/mcp/client.ts", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    callTool: vi.fn(),
    getTools: vi.fn().mockReturnValue([]),
    hasTool: vi.fn().mockReturnValue(true),
  })),
}));

describe("mcp() destination adapter", () => {
  test("creates adapter with options", () => {
    const adapter = mcp({
      server: {
        name: "test-server",
        transport: "stdio",
        command: "test-command",
      },
      tool: "test-tool",
    });
    
    expect(adapter.adapterId).toBe("routecraft.ai.adapter.mcp.destination");
  });
  
  test("resolves static tool name", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "my-tool",
    });
    
    const mockExchange = {
      body: { arg1: "value" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.send(mockExchange);
    
    expect(mockCallTool).toHaveBeenCalledWith("my-tool", { arg1: "value" });
  });
  
  test("resolves dynamic tool name", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: (body: any) => body.toolName,
    });
    
    const mockExchange = {
      body: { toolName: "dynamic-tool", data: "test" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.send(mockExchange);
    
    expect(mockCallTool).toHaveBeenCalledWith("dynamic-tool", expect.anything());
  });
  
  test("uses mapArguments to transform body", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "read_file",
      mapArguments: (body: any) => ({ path: body.filePath }),
    });
    
    const mockExchange = {
      body: { filePath: "/tmp/test.txt", extra: "ignored" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.send(mockExchange);
    
    expect(mockCallTool).toHaveBeenCalledWith("read_file", { path: "/tmp/test.txt" });
  });
  
  test("uses mapResult to transform response", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "list_files",
      mapResult: (result) => result.content.map((c) => c.text),
    });
    
    const mockExchange = {
      body: {},
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.send(mockExchange);
    
    expect(mockExchange.body).toEqual(["line1", "line2"]);
  });
  
  test("throws on tool error", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Something went wrong" }],
      isError: true,
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "failing-tool",
    });
    
    const mockExchange = {
      body: {},
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await expect(adapter.send(mockExchange)).rejects.toThrow("MCP tool error");
  });
});
```

### 7. Create test/mcp-enrich.test.ts

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mcp, MCPClient } from "../src/index.ts";
import type { MCPToolResult } from "../src/index.ts";

// Mock MCPClient
vi.mock("../src/mcp/client.ts", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    callTool: vi.fn(),
    getTools: vi.fn().mockReturnValue([]),
    hasTool: vi.fn().mockReturnValue(true),
  })),
}));

describe("mcp() enrich adapter", () => {
  test("enrich() adds result under enrichKey", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "File content here" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "read_file",
      enrichKey: "fileContent",
    });
    
    const mockExchange = {
      body: { docId: "readme", format: "md" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.enrich(mockExchange);
    
    expect(mockExchange.body).toEqual({
      docId: "readme",
      format: "md",
      fileContent: "File content here",
    });
  });
  
  test("enrich() merges object result at top level without enrichKey", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name": "John", "email": "john@example.com"}' }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "get_user",
      mapResult: (result) => JSON.parse(result.content[0].text!),
    });
    
    const mockExchange = {
      body: { userId: "123" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.enrich(mockExchange);
    
    expect(mockExchange.body).toEqual({
      userId: "123",
      name: "John",
      email: "john@example.com",
    });
  });
  
  test("enrich() stores non-object result under 'mcpResult'", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "plain string result" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "some_tool",
      // No enrichKey and result is a string
    });
    
    const mockExchange = {
      body: { original: "data" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.enrich(mockExchange);
    
    expect(mockExchange.body).toEqual({
      original: "data",
      mcpResult: "plain string result",
    });
  });
  
  test("enrich() preserves original body properties", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "enrichment data" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "enrich_tool",
      enrichKey: "enriched",
    });
    
    const mockExchange = {
      body: {
        id: 1,
        name: "test",
        nested: { a: 1, b: 2 },
      },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.enrich(mockExchange);
    
    expect(mockExchange.body).toEqual({
      id: 1,
      name: "test",
      nested: { a: 1, b: 2 },
      enriched: "enrichment data",
    });
  });
  
  test("enrich() uses mapArguments", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    } as MCPToolResult);
    
    vi.mocked(MCPClient).mockImplementation(() => ({
      connect: vi.fn(),
      callTool: mockCallTool,
    } as any));
    
    const adapter = mcp({
      server: { name: "test", transport: "stdio", command: "cmd" },
      tool: "read_file",
      mapArguments: (body: any) => ({ path: `/docs/${body.docId}.md` }),
      enrichKey: "content",
    });
    
    const mockExchange = {
      body: { docId: "readme" },
      headers: {},
      logger: { debug: vi.fn() },
    } as any;
    
    await adapter.enrich(mockExchange);
    
    expect(mockCallTool).toHaveBeenCalledWith("read_file", { path: "/docs/readme.md" });
  });
});
```

## Dependencies

Add to package.json:

```json
{
  "dependencies": {
    "@routecraft/routecraft": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

## Success Criteria

- [ ] `mcp()` creates an adapter that works with both `.to()` and `.enrich()`
- [ ] `.to(mcp())` replaces body with result
- [ ] `.enrich(mcp())` merges result into body
- [ ] `enrichKey` option stores result under specific key
- [ ] Without `enrichKey`, object results merge at top level
- [ ] Without `enrichKey`, non-object results stored under `mcpResult`
- [ ] Static and dynamic tool names work
- [ ] Arguments mapping works
- [ ] Result mapping works
- [ ] Error handling works
- [ ] All tests pass (with mocked client)
- [ ] Manual test with real MCP server (filesystem)

## Usage Examples

### Read a file and use its content

```typescript
craft()
  .from(simple({ docPath: 'README.md' }))
  .enrich(mcp({
    server: filesystemServer,
    tool: 'read_file',
    mapArguments: (body) => ({ path: body.docPath }),
    enrichKey: 'content',
  }))
  .process(llm({
    provider: openai,
    model: 'gpt-4o-mini',
    prompt: 'Summarize this document: {body.content}',
  }))
  .to(destination)
```

### Fetch user data and merge into request

```typescript
craft()
  .from(simple({ userId: '123', action: 'greet' }))
  .enrich(mcp({
    server: apiServer,
    tool: 'get_user',
    mapArguments: (body) => ({ id: body.userId }),
    // Result { name: 'John', email: '...' } merged into body
  }))
  .process(({ action, name }) => {
    // Now we have userId, action, name, email
    return `Hello, ${name}!`
  })
```

### Chain multiple enrichments

```typescript
craft()
  .from(simple({ projectId: 'abc' }))
  .enrich(mcp({
    server: githubServer,
    tool: 'get_repo',
    mapArguments: (body) => ({ id: body.projectId }),
    enrichKey: 'repo',
  }))
  .enrich(mcp({
    server: githubServer,
    tool: 'list_issues',
    mapArguments: (body) => ({ repo: body.repo.name }),
    enrichKey: 'issues',
  }))
  .process(({ projectId, repo, issues }) => {
    // Full context: project ID, repo details, and issues
    return generateReport(repo, issues)
  })
```

## Next Steps

After this plan is complete:
- Plan 5: MCP Source (expose tools via `.from(mcp())`)
- Plan 6: Agent Routing
