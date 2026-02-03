---
name: AI Package MCP Adapters
overview: Create @routecraft/ai package with bidirectional MCP integration via mcp() adapter for both exposing routes as tools and calling external MCP tools.
dependencies:
  - Plan 1 (Direct Schema Validation) must be merged first
todos:
  - id: ai-package-setup
    content: Create package structure, package.json, and build config
    status: pending
  - id: schema-converter
    content: Create Zod to JSON Schema converter utility
    status: pending
  - id: mcp-server
    content: Implement MCP server wrapper for exposing tools
    status: pending
  - id: mcp-client
    content: Implement MCP client wrapper for calling external tools
    status: pending
  - id: mcp-source
    content: Create mcp() source adapter for exposing routes as tools
    status: pending
  - id: mcp-destination
    content: Create mcp() destination adapter for calling external tools
    status: pending
  - id: mcp-tests
    content: Write comprehensive tests for MCP adapters
    status: pending
  - id: mcp-docs
    content: Create documentation and examples
    status: pending
---

# AI Package: MCP Adapters

## Overview

Create `@routecraft/ai` package with bidirectional MCP (Model Context Protocol) integration:

1. **Expose routes as MCP tools** - Make RouteCraft routes callable by Claude, Cursor, etc.
2. **Call external MCP tools** - Use filesystem, github, and other MCP tools from RouteCraft

## Why This is Separate

MCP integration is **completely independent** of LLM/Agent features. Can be used standalone for:
- Exposing RouteCraft workflows as tools
- Integrating with MCP-enabled applications
- Building tool ecosystems

## Dependency

**Requires Plan 1 (Direct Schema Validation)** because `mcp()` source uses the direct route registry.

## Package Structure

```
packages/ai/
├── package.json
├── README.md
├── tsconfig.json
├── tsup.config.mjs
├── vitest.config.mjs
├── src/
│   ├── index.ts
│   ├── adapters/
│   │   └── mcp.ts              # mcp() source & destination
│   ├── mcp/
│   │   ├── server.ts           # MCP server for exposing tools
│   │   ├── client.ts           # MCP client for calling external tools
│   │   └── registry.ts         # Tool registry
│   └── utils/
│       └── schema.ts           # Zod to JSON Schema conversion
└── test/
    ├── mcp-source.test.ts
    ├── mcp-destination.test.ts
    ├── mcp-server.test.ts
    ├── mcp-client.test.ts
    └── mocks/
        └── mcp-server.ts
```

## Implementation

### 1. Package Configuration

File: `packages/ai/package.json`

```json
{
  "name": "@routecraft/ai",
  "version": "0.1.0",
  "description": "AI and MCP integration for RouteCraft",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "test": "vitest",
    "prepublishOnly": "pnpm run build"
  },
  "dependencies": {
    "@routecraft/routecraft": "workspace:*",
    "@standard-schema/spec": "^1.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "peerDependencies": {
    "zod": "^3.22.0"
  },
  "keywords": [
    "routecraft",
    "mcp",
    "model-context-protocol",
    "tools",
    "ai"
  ],
  "author": "routecraftjs",
  "license": "Apache-2.0"
}
```

File: `packages/ai/tsup.config.mjs`

```javascript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
```

### 2. Schema Converter Utility

File: `packages/ai/src/utils/schema.ts`

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Convert Zod schema (StandardSchemaV1) to JSON Schema
 * for MCP tool definitions.
 */
export function zodToJsonSchema(schema: StandardSchemaV1): Record<string, any> {
  // Use the schema's ~standard.validate metadata to introspect
  // This is a simplified implementation - production would use zod-to-json-schema
  
  // For now, extract basic info from schema
  const schemaTyped = schema as any;
  
  // Most Zod schemas expose _def with type info
  if (schemaTyped._def) {
    return convertZodDefToJsonSchema(schemaTyped._def);
  }
  
  // Fallback: minimal schema
  return {
    type: "object",
    additionalProperties: true
  };
}

function convertZodDefToJsonSchema(def: any): Record<string, any> {
  // This would be a full Zod->JSON Schema converter
  // For MVP, we can use the zod-to-json-schema package
  // Or implement basic type conversions
  
  const type = def.typeName;
  
  switch (type) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return {
        type: 'array',
        items: convertZodDefToJsonSchema(def.type._def)
      };
    case 'ZodObject':
      const properties: Record<string, any> = {};
      const required: string[] = [];
      
      for (const [key, value] of Object.entries(def.shape())) {
        const propSchema = value as any;
        properties[key] = convertZodDefToJsonSchema(propSchema._def);
        if (!propSchema.isOptional()) {
          required.push(key);
        }
      }
      
      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined
      };
    default:
      return { type: 'any' };
  }
}
```

### 3. MCP Server

File: `packages/ai/src/mcp/server.ts`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { zodToJsonSchema } from '../utils/schema';

export interface McpToolDefinition<T = unknown> {
  name: string;
  description: string;
  inputSchema: StandardSchemaV1;
  handler: (args: T) => Promise<any>;
}

/**
 * MCP server for exposing RouteCraft tools to MCP clients.
 * Used by mcp() source adapter.
 */
export class McpServer {
  private server: Server;
  private tools = new Map<string, McpToolDefinition>();
  
  constructor(
    private name: string = 'routecraft',
    private version: string = '1.0.0'
  ) {
    this.server = new Server({
      name: this.name,
      version: this.version
    }, {
      capabilities: {
        tools: {}
      }
    });
    
    this.setupHandlers();
  }
  
  /**
   * Register a tool from mcp() source adapter
   */
  registerTool(tool: McpToolDefinition) {
    this.tools.set(tool.name, tool);
  }
  
  /**
   * Unregister a tool
   */
  unregisterTool(name: string) {
    this.tools.delete(name);
  }
  
  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler('tools/list', async () => {
      return {
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: zodToJsonSchema(tool.inputSchema)
        }))
      };
    });
    
    // Call a tool
    this.server.setRequestHandler('tools/call', async (request: any) => {
      const { name, arguments: args } = request.params;
      const tool = this.tools.get(name);
      
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }
      
      try {
        const result = await tool.handler(args);
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' 
              ? result 
              : JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Tool execution failed: ${error.message}`);
      }
    });
  }
  
  /**
   * Start the MCP server (stdio transport)
   */
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Store in context
declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    "routecraft.ai.mcp.server": McpServer;
  }
}
```

### 4. MCP Client

File: `packages/ai/src/mcp/client.ts`

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

/**
 * MCP client for calling external MCP tools.
 * Used by mcp() destination adapter.
 */
export class McpClient {
  private client: Client;
  private tools: Map<string, McpTool> = new Map();
  private connected = false;
  
  constructor(
    private serverName: string,
    private options: McpClientOptions
  ) {
    this.client = new Client({
      name: 'routecraft-client',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
  }
  
  /**
   * Connect to the MCP server
   */
  async connect() {
    if (this.connected) return;
    
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: this.options.env
    });
    
    await this.client.connect(transport);
    this.connected = true;
    
    // Load available tools
    await this.loadTools();
  }
  
  /**
   * Load tools from the MCP server
   */
  private async loadTools() {
    const response = await this.client.request({
      method: 'tools/list'
    }, {});
    
    for (const tool of response.tools) {
      this.tools.set(tool.name, tool);
    }
  }
  
  /**
   * Get available tools
   */
  getTools(): McpTool[] {
    return Array.from(this.tools.values());
  }
  
  /**
   * Check if tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
  
  /**
   * Call a tool
   */
  async callTool<T = any>(name: string, args: Record<string, any>): Promise<T> {
    if (!this.connected) {
      await this.connect();
    }
    
    if (!this.hasTool(name)) {
      throw new Error(`Tool "${name}" not found in server "${this.serverName}"`);
    }
    
    const response = await this.client.request({
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    }, {});
    
    // Extract text content from response
    if (response.content && response.content[0]?.type === 'text') {
      const text = response.content[0].text;
      
      // Try to parse as JSON if possible
      try {
        return JSON.parse(text);
      } catch {
        return text as T;
      }
    }
    
    return response as T;
  }
  
  /**
   * Disconnect from server
   */
  async disconnect() {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

// Registry for MCP clients
declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    "routecraft.ai.mcp.clients": Map<string, McpClient>;
  }
}
```

### 5. MCP Source Adapter

File: `packages/ai/src/adapters/mcp.ts`

```typescript
import type { Source, Destination, Exchange, CraftContext, ExchangeHeaders } from '@routecraft/routecraft';
import { DirectAdapter, type DirectAdapterOptions } from '@routecraft/routecraft';
import { McpServer } from '../mcp/server';
import { McpClient } from '../mcp/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';

// Source adapter options
export interface McpSourceOptions extends Omit<DirectAdapterOptions, 'channelType'> {
  /** MCP server to register this tool with (defaults to global server) */
  mcpServer?: McpServer;
  
  /**
   * Tool name for MCP clients (defaults to endpoint name).
   * Must be valid MCP tool name (alphanumeric + underscores).
   */
  toolName?: string;
}

// Destination adapter options
export interface McpDestinationOptions<T = unknown> {
  /** MCP server name */
  server: string;
  
  /** Tool name from that server */
  tool: string;
  
  /** 
   * Arguments to pass to the tool.
   * Can be static object or function that extracts from exchange.
   */
  arguments: Record<string, any> | ((exchange: Exchange<T>) => Record<string, any> | Promise<Record<string, any>>);
  
  /** Optional: transform the tool result before returning */
  transformResult?: (result: any) => any;
}

/**
 * MCP Source Adapter - Expose RouteCraft route as MCP tool
 */
class McpSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId = 'routecraft.ai.mcp.source';
  private directAdapter: DirectAdapter<T>;
  
  constructor(
    private endpoint: string,
    private options: McpSourceOptions
  ) {
    // Wrap a direct adapter
    this.directAdapter = new DirectAdapter<T>(endpoint, options);
  }
  
  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController
  ): Promise<void> {
    // Register with MCP server
    const mcpServer = this.options.mcpServer || 
      context.getStore('routecraft.ai.mcp.server');
    
    if (mcpServer && this.options.description && this.options.schema) {
      const toolName = this.options.toolName || 
        this.endpoint.replace(/[^a-zA-Z0-9_]/g, '_');
        
      mcpServer.registerTool({
        name: toolName,
        description: this.options.description,
        inputSchema: this.options.schema,
        handler: async (args: T) => {
          // Call the handler and return result
          const exchange = await handler(args);
          return exchange.body;
        }
      });
      
      // Cleanup on abort
      abortController.signal.addEventListener('abort', () => {
        mcpServer.unregisterTool(toolName);
      });
    }
    
    // Delegate to direct adapter for actual subscription
    return this.directAdapter.subscribe(context, handler, abortController);
  }
}

/**
 * MCP Destination Adapter - Call external MCP tool
 */
class McpDestinationAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = 'routecraft.ai.mcp.destination';
  
  constructor(private options: McpDestinationOptions<T>) {}
  
  async send(exchange: Exchange<T>): Promise<void> {
    const context = (exchange as any).context as CraftContext;
    
    // Get or create MCP client for this server
    const client = await this.getOrCreateClient(context);
    
    // Extract arguments
    const args = typeof this.options.arguments === 'function'
      ? await this.options.arguments(exchange)
      : this.options.arguments;
    
    // Call the tool
    const result = await client.callTool(this.options.tool, args);
    
    // Transform result if needed
    const finalResult = this.options.transformResult
      ? this.options.transformResult(result)
      : result;
    
    // Update exchange body with result
    (exchange as any).body = finalResult;
  }
  
  private async getOrCreateClient(context: CraftContext): Promise<McpClient> {
    let clients = context.getStore('routecraft.ai.mcp.clients');
    
    if (!clients) {
      clients = new Map();
      context.setStore('routecraft.ai.mcp.clients', clients);
    }
    
    if (!clients.has(this.options.server)) {
      // TODO: Get server config from context store
      // For now, throw error if server not configured
      throw new Error(
        `MCP server "${this.options.server}" not configured. ` +
        `Add server config to context store.`
      );
    }
    
    return clients.get(this.options.server)!;
  }
}

/**
 * Factory function with overloads for source/destination
 */
export function mcp<T = unknown>(
  endpoint: string,
  options: McpSourceOptions
): McpSourceAdapter<T>;

export function mcp<T = unknown>(
  options: McpDestinationOptions<T>
): McpDestinationAdapter<T>;

export function mcp<T = unknown>(
  endpointOrOptions: string | McpDestinationOptions<T>,
  options?: McpSourceOptions
): McpSourceAdapter<T> | McpDestinationAdapter<T> {
  if (typeof endpointOrOptions === 'string') {
    // Source mode
    return new McpSourceAdapter<T>(endpointOrOptions, options!);
  } else {
    // Destination mode
    return new McpDestinationAdapter<T>(endpointOrOptions);
  }
}
```

### 6. Package Index

File: `packages/ai/src/index.ts`

```typescript
// MCP adapters
export { mcp } from './adapters/mcp';
export type { McpSourceOptions, McpDestinationOptions } from './adapters/mcp';

// MCP server/client
export { McpServer } from './mcp/server';
export { McpClient } from './mcp/client';
export type { McpClientOptions, McpTool } from './mcp/client';

// Utilities
export { zodToJsonSchema } from './utils/schema';
```

## Testing

### MCP Source Tests

File: `packages/ai/test/mcp-source.test.ts`

```typescript
import { expect, test, vi } from "vitest";
import { context, craft, simple } from "@routecraft/routecraft";
import { mcp, McpServer } from "@routecraft/ai";
import { z } from "zod";

test("mcp source registers tool with MCP server", async () => {
  const mcpServer = new McpServer('test-server');
  
  const ctx = context()
    .store('routecraft.ai.mcp.server', mcpServer)
    .routes(
      craft()
        .id('mcp-route')
        .from(mcp('test-tool', {
          description: 'Test tool',
          schema: z.object({ input: z.string() })
        }))
        .to(vi.fn())
    )
    .build();
  
  await ctx.start();
  
  // Check tool is registered
  const tools = (await mcpServer.server.request({ method: 'tools/list' }, {})).tools;
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe('test_tool');
  
  await ctx.stop();
});
```

### MCP Destination Tests

File: `packages/ai/test/mcp-destination.test.ts`

```typescript
import { expect, test, vi } from "vitest";
import { context, craft, simple } from "@routecraft/routecraft";
import { mcp, McpClient } from "@routecraft/ai";

test("mcp destination calls external MCP tool", async () => {
  // Mock MCP client
  const mockClient = new McpClient('test-server', { command: 'test' });
  mockClient.callTool = vi.fn().mockResolvedValue({ success: true });
  
  const ctx = context()
    .store('routecraft.ai.mcp.clients', new Map([['test-server', mockClient]]))
    .routes(
      craft()
        .id('call-mcp')
        .from(simple({ data: 'test' }))
        .to(mcp({
          server: 'test-server',
          tool: 'write_file',
          arguments: (ex) => ({ content: ex.body.data })
        }))
    )
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(mockClient.callTool).toHaveBeenCalledWith('write_file', {
    content: 'test'
  });
});
```

## Documentation

### README

File: `packages/ai/README.md`

```markdown
# @routecraft/ai

AI and MCP integration for RouteCraft.

## Installation

```bash
pnpm add @routecraft/ai zod
```

## MCP Integration

### Expose Routes as MCP Tools

Make your RouteCraft routes callable by Claude, Cursor, and other MCP clients:

```typescript
import { mcp } from '@routecraft/ai';
import { z } from 'zod';

craft()
  .from(mcp('analyze-code', {
    description: 'Analyze code quality and provide suggestions',
    schema: z.object({ 
      code: z.string(),
      language: z.string()
    })
  }))
  .process(analyzeCode)
```

### Call External MCP Tools

Use filesystem, github, and other MCP tools from your routes:

```typescript
craft()
  .from(source)
  .to(mcp({
    server: 'filesystem',
    tool: 'write_file',
    arguments: (ex) => ({
      path: `/output/${ex.body.filename}`,
      content: ex.body.content
    })
  }))
```

## Examples

See `/examples` directory for complete examples.
```

## Success Criteria

- ✅ Package builds and publishes
- ✅ MCP server exposes tools correctly
- ✅ MCP client calls external tools
- ✅ mcp() source registers and handles calls
- ✅ mcp() destination invokes external tools
- ✅ All tests passing
- ✅ Documentation complete

## Estimate

**Total: 8-10 hours**
- Package setup: 1 hour
- Schema converter: 1-2 hours
- MCP server/client: 3-4 hours
- mcp() adapters: 2-3 hours
- Testing: 1-2 hours
- Documentation: 1 hour
