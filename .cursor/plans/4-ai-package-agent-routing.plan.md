---
name: AI Package Agent Routing
overview: Add agent() destination adapter to @routecraft/ai for AI-powered routing that auto-discovers direct routes and decides where to send messages based on descriptions.
dependencies:
  - Plan 1 (Direct Schema Validation) - uses route registry
  - Plan 3 (AI Package LLM Adapters) - uses LLMProvider for function calling
todos:
  - id: agent-adapter
    content: Create agent() destination adapter with auto-discovery
    status: pending
  - id: agent-allowlist
    content: Implement allowlist filtering for security
    status: pending
  - id: agent-prompts
    content: Implement prompt building from exchange data
    status: pending
  - id: agent-routing
    content: Implement AI decision-making and route calling
    status: pending
  - id: agent-fallback
    content: Add fallback endpoint handling
    status: pending
  - id: agent-mcp-tools
    content: Add support for routing to MCP tools (optional)
    status: pending
  - id: agent-tests
    content: Write comprehensive tests for agent routing
    status: pending
  - id: agent-docs
    content: Create documentation and examples
    status: pending
---

# AI Package: Agent Routing

## Overview

Add AI-powered routing to `@routecraft/ai` via `agent()` destination adapter:

1. **Auto-discovery** - Discovers direct routes with descriptions from context registry
2. **AI decision-making** - Uses LLM function calling to choose the right route
3. **Security** - Optional allowlist to restrict available routes
4. **Flexible** - Can route to direct routes and optionally MCP tools

## Why This is Separate

Agent routing is the **highest-level AI feature** that combines:
- Direct route registry (Plan 1)
- LLM function calling (Plan 3)
- Optionally MCP tools (Plan 2)

This is the "magic" that makes AI routing work.

## Dependencies

**Requires:**
- **Plan 1** - Direct route registry for auto-discovery
- **Plan 3** - LLMProvider with function calling for routing decisions

**Optionally uses:**
- **Plan 2** - MCP tools can be included in routing options

## Implementation

### 1. Agent Adapter

File: `packages/ai/src/adapters/agent.ts`

```typescript
import type { Destination, Exchange, CraftContext } from '@routecraft/routecraft';
import { DirectAdapter } from '@routecraft/routecraft';
import type { LLMProvider, FunctionDefinition } from '../providers/base';
import { zodToJsonSchema } from '../utils/schema';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export interface AgentOptions<T = unknown> {
  /**
   * Allowlist of endpoints to restrict routing.
   * If not provided, all registered routes are available.
   * RECOMMENDED for production - prevents AI from calling unintended routes.
   */
  allowlist?: string[];
  
  /**
   * Custom system prompt for routing decisions.
   * Default provides clear instructions for route selection.
   */
  systemPrompt?: string | ((exchange: Exchange<T>) => string | Promise<string>);
  
  /**
   * LLM provider for routing decisions.
   * Defaults to context store 'routecraft.ai.provider'.
   */
  provider?: LLMProvider;
  
  /**
   * Include exchange body in routing prompt (default: true).
   * Body is JSON-stringified and included in user prompt.
   */
  includeBody?: boolean;
  
  /**
   * Include headers in routing prompt (default: false).
   * Can be true (all headers) or array of specific header keys.
   */
  includeHeaders?: boolean | string[];
  
  /**
   * Fallback endpoint if AI fails or returns invalid result.
   * If not provided, errors are thrown.
   */
  fallbackEndpoint?: string;
  
  /**
   * Model to use for routing decisions.
   * Defaults to provider's default model.
   */
  model?: string;
  
  /**
   * Temperature for routing decisions (default: 0.0).
   * Use 0.0 for deterministic routing.
   */
  temperature?: number;
  
  /**
   * External MCP tools to include in routing options.
   * Requires MCP client to be configured.
   * OPTIONAL - only needed if routing to external tools.
   */
  mcpTools?: McpToolReference[];
}

export interface McpToolReference {
  /** MCP server name */
  server: string;
  
  /** Tool name from that server */
  tool: string;
  
  /** Override description (optional, uses MCP description by default) */
  description?: string;
}

interface RouteOption {
  endpoint: string;
  description: string;
  schema: StandardSchemaV1;
  keywords?: string[];
  type: 'direct' | 'mcp';
  mcpServer?: string;
}

/**
 * AI-powered routing adapter.
 * 
 * Automatically discovers direct routes with descriptions and uses
 * LLM function calling to decide which route to send messages to.
 * 
 * @example
 * import { chat } from '@routecraft/google';
 * import { agent } from '@routecraft/ai';
 * 
 * // Auto-discover all direct routes
 * craft()
 *   .from(chat('/help'))
 *   .to(agent())
 * 
 * @example
 * // With allowlist for security
 * craft()
 *   .from(chat('/restricted'))
 *   .to(agent({
 *     allowlist: ['fetch-content', 'generate-letter', 'validate-letter']
 *   }))
 * 
 * @example
 * // With MCP tools
 * craft()
 *   .from(chat('/assistant'))
 *   .to(agent({
 *     mcpTools: [
 *       { server: 'filesystem', tool: 'read_file' },
 *       { server: 'github', tool: 'search_repositories' }
 *     ]
 *   }))
 */
export class AgentAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = 'routecraft.ai.agent';
  
  constructor(private options: AgentOptions<T> = {}) {}
  
  async send(exchange: Exchange<T>): Promise<void> {
    const context = (exchange as any).context as CraftContext;
    
    // Get provider
    const provider = this.getProvider(context);
    
    // Get available routes
    const routes = this.getAvailableRoutes(context);
    
    if (routes.length === 0) {
      throw new Error(
        'No routes available for agent(). ' +
        'Register direct routes with descriptions using direct(endpoint, { description: "..." })'
      );
    }
    
    try {
      // Build prompts
      const systemPrompt = await this.buildSystemPrompt(exchange);
      const userPrompt = this.buildUserPrompt(exchange);
      
      // Convert routes to function definitions
      const functions: FunctionDefinition[] = routes.map(route => ({
        name: route.type === 'direct' ? route.endpoint : `mcp_${route.endpoint}`,
        description: route.description,
        parameters: zodToJsonSchema(route.schema)
      }));
      
      // Call LLM for routing decision
      const result = await provider.functionCall!({
        systemPrompt,
        userPrompt,
        functions,
        model: this.options.model
      });
      
      // Find the chosen route
      const chosenRoute = routes.find(r => {
        const name = r.type === 'direct' ? r.endpoint : `mcp_${r.endpoint}`;
        return name === result.functionName;
      });
      
      if (!chosenRoute) {
        throw new Error(`AI chose unknown route: ${result.functionName}`);
      }
      
      // Route to the chosen endpoint
      await this.routeToEndpoint(exchange, chosenRoute, result.arguments);
      
    } catch (error) {
      // Handle fallback
      if (this.options.fallbackEndpoint) {
        exchange.logger.warn(
          `Agent routing failed, using fallback: ${error.message}`
        );
        const directAdapter = new DirectAdapter(this.options.fallbackEndpoint);
        await directAdapter.send(exchange);
      } else {
        throw error;
      }
    }
  }
  
  private getProvider(context: CraftContext): LLMProvider {
    const provider = this.options.provider || 
      context.getStore('routecraft.ai.provider');
      
    if (!provider) {
      throw new Error(
        'No LLM provider configured for agent(). ' +
        'Add provider to context store or agent options.'
      );
    }
    
    if (!provider.functionCall) {
      throw new Error(
        'LLM provider does not support function calling. ' +
        'Use a provider that implements functionCall() method.'
      );
    }
    
    return provider;
  }
  
  private getAvailableRoutes(context: CraftContext): RouteOption[] {
    const routes: RouteOption[] = [];
    
    // Get direct routes from registry
    const registry = context.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    
    if (registry) {
      for (const metadata of registry.values()) {
        // Only include routes with description (AI-discoverable)
        if (metadata.description && metadata.schema) {
          // Apply allowlist filter
          if (!this.options.allowlist || this.options.allowlist.includes(metadata.endpoint)) {
            routes.push({
              endpoint: metadata.endpoint,
              description: metadata.description,
              schema: metadata.schema,
              keywords: metadata.keywords,
              type: 'direct'
            });
          }
        }
      }
    }
    
    // Add MCP tools if provided
    if (this.options.mcpTools) {
      for (const mcpTool of this.options.mcpTools) {
        // TODO: Get schema from MCP server
        // For now, skip MCP tools - they need schema
        // This will be enhanced when MCP integration is more mature
      }
    }
    
    return routes;
  }
  
  private async buildSystemPrompt(exchange: Exchange<T>): Promise<string> {
    if (this.options.systemPrompt) {
      return typeof this.options.systemPrompt === 'function'
        ? await this.options.systemPrompt(exchange)
        : this.options.systemPrompt;
    }
    
    return `You are a routing assistant for a message processing system.

Your task is to analyze the incoming request and choose the most appropriate function to call.

Guidelines:
- Read the user's request carefully
- Match the request to the function that best fits the task
- Consider the function descriptions and parameters
- If multiple functions could work, choose the most specific one
- Extract the required parameters from the request

Be precise and confident in your choice.`;
  }
  
  private buildUserPrompt(exchange: Exchange<T>): string {
    let prompt = '';
    
    // Include body if not disabled
    if (this.options.includeBody !== false) {
      prompt += `Request:\n${JSON.stringify(exchange.body, null, 2)}\n\n`;
    }
    
    // Include headers if requested
    if (this.options.includeHeaders) {
      const headers = this.options.includeHeaders === true
        ? exchange.headers
        : Object.fromEntries(
            Object.entries(exchange.headers).filter(([k]) =>
              (this.options.includeHeaders as string[]).includes(k)
            )
          );
      prompt += `Headers:\n${JSON.stringify(headers, null, 2)}\n\n`;
    }
    
    prompt += 'Choose the appropriate function and extract the required parameters from the request.';
    
    return prompt;
  }
  
  private async routeToEndpoint(
    exchange: Exchange<T>,
    route: RouteOption,
    args: Record<string, any>
  ): Promise<void> {
    if (route.type === 'direct') {
      // Route to direct endpoint
      const directAdapter = new DirectAdapter(route.endpoint);
      await directAdapter.send({
        ...exchange,
        body: args as T
      });
    } else if (route.type === 'mcp') {
      // Route to MCP tool
      // This requires MCP client integration from Plan 2
      throw new Error('MCP routing not yet implemented');
    }
  }
}

/**
 * Factory function for agent adapter
 */
export function agent<T = unknown>(options?: AgentOptions<T>): AgentAdapter<T> {
  return new AgentAdapter(options);
}
```

### 2. Update Package Exports

File: `packages/ai/src/index.ts`

```typescript
// MCP adapters
export { mcp } from './adapters/mcp';
export type { McpSourceOptions, McpDestinationOptions } from './adapters/mcp';

// LLM adapters
export { llm } from './adapters/llm';
export type { LLMProcessorOptions, LLMTransformerOptions } from './adapters/llm';

// Agent adapter (NEW)
export { agent } from './adapters/agent';
export type { AgentOptions, McpToolReference } from './adapters/agent';

// Providers
export { OpenAIProvider } from './providers/openai';
export type { LLMProvider, CompletionOptions, CompletionResult } from './providers/base';

// MCP server/client
export { McpServer } from './mcp/server';
export { McpClient } from './mcp/client';
export type { McpClientOptions, McpTool } from './mcp/client';

// Utilities
export { zodToJsonSchema } from './utils/schema';
```

## Testing

### Agent Tests

File: `packages/ai/test/agent.test.ts`

```typescript
import { expect, test, vi } from "vitest";
import { context, craft, simple, direct, DirectAdapter } from "@routecraft/routecraft";
import { agent } from "@routecraft/ai";
import { MockLLMProvider } from "./mocks/provider";
import { z } from "zod";

test("agent auto-discovers routes from registry", async () => {
  const provider = new MockLLMProvider();
  
  // Mock function call to return route choice
  provider.functionCall = vi.fn().mockResolvedValue({
    functionName: 'fetch-content',
    arguments: { url: 'https://example.com' }
  });
  
  const handler = vi.fn();
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .routes([
      // Discoverable route
      craft()
        .id('fetch-route')
        .from(direct('fetch-content', {
          description: 'Fetch web content',
          schema: z.object({ url: z.string().url() })
        }))
        .to(handler),
      
      // Route that triggers agent
      craft()
        .id('chat')
        .from(simple({ message: 'Fetch https://example.com' }))
        .to(agent())
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  await ctx.stop();
  
  // Verify function call was made
  expect(provider.functionCall).toHaveBeenCalled();
  
  // Verify route was called with transformed args
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0][0].body).toEqual({ url: 'https://example.com' });
});

test("agent respects allowlist", async () => {
  const provider = new MockLLMProvider();
  
  provider.functionCall = vi.fn().mockResolvedValue({
    functionName: 'allowed-route',
    arguments: {}
  });
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .routes([
      craft()
        .from(direct('allowed-route', {
          description: 'Allowed',
          schema: z.object({})
        }))
        .to(vi.fn()),
      
      craft()
        .from(direct('blocked-route', {
          description: 'Blocked',
          schema: z.object({})
        }))
        .to(vi.fn()),
      
      craft()
        .from(simple({}))
        .to(agent({
          allowlist: ['allowed-route']
        }))
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  await ctx.stop();
  
  // Verify only allowed route was in function definitions
  const functions = provider.functionCall.mock.calls[0][0].functions;
  expect(functions).toHaveLength(1);
  expect(functions[0].name).toBe('allowed-route');
});

test("agent uses fallback on error", async () => {
  const provider = new MockLLMProvider();
  
  provider.functionCall = vi.fn().mockRejectedValue(new Error('AI failed'));
  
  const fallbackHandler = vi.fn();
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .routes([
      craft()
        .from(direct('route1', {
          description: 'Route 1',
          schema: z.object({})
        }))
        .to(vi.fn()),
      
      craft()
        .from(direct('fallback', {
          schema: z.object({})
        }))
        .to(fallbackHandler),
      
      craft()
        .from(simple({}))
        .to(agent({
          fallbackEndpoint: 'fallback'
        }))
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  await ctx.stop();
  
  // Verify fallback was called
  expect(fallbackHandler).toHaveBeenCalledTimes(1);
});

test("agent throws error when no provider", async () => {
  const errorHandler = vi.fn();
  
  const ctx = context()
    .on('error', errorHandler)
    .routes([
      craft()
        .from(direct('route1', {
          description: 'Route 1',
          schema: z.object({})
        }))
        .to(vi.fn()),
      
      craft()
        .from(simple({}))
        .to(agent()) // No provider!
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(errorHandler).toHaveBeenCalled();
  const error = errorHandler.mock.calls[0][0].details.error;
  expect(error.message).toContain('No LLM provider');
});

test("agent throws error when no routes available", async () => {
  const provider = new MockLLMProvider();
  const errorHandler = vi.fn();
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .on('error', errorHandler)
    .routes(
      craft()
        .from(simple({}))
        .to(agent()) // No discoverable routes!
    )
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(errorHandler).toHaveBeenCalled();
  const error = errorHandler.mock.calls[0][0].details.error;
  expect(error.message).toContain('No routes available');
});
```

## Documentation

### Update README

File: `packages/ai/README.md`

Add agent routing section:

```markdown
## Agent Routing

### Auto-Discovery

The agent() destination automatically discovers direct routes with descriptions:

```typescript
import { chat } from '@routecraft/google';
import { agent, OpenAIProvider } from '@routecraft/ai';
import OpenAI from 'openai';
import { z } from 'zod';

// Configure provider
const provider = new OpenAIProvider(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
);

// Define discoverable routes
craft()
  .from(direct('fetch-content', {
    description: 'Fetch and summarize web content from a URL',
    schema: z.object({ url: z.string().url() })
  }))
  .process(fetchAndSummarize)

craft()
  .from(direct('generate-letter', {
    description: 'Generate a motivation letter from job description',
    schema: z.object({ 
      jobDescription: z.string(),
      cvPath: z.string()
    })
  }))
  .process(generateLetter)

// AI agent discovers and routes
const ctx = context()
  .store('routecraft.ai.provider', provider)
  .routes([
    // ... discoverable routes above ...
    
    craft()
      .from(chat('/assistant'))
      .to(agent()) // Auto-discovers all routes!
  ])
  .build();
```

### Security with Allowlist

Always use allowlist in production:

```typescript
craft()
  .from(chat('/restricted'))
  .to(agent({
    allowlist: ['fetch-content', 'generate-letter']
  }))
```

### Fallback Handling

Provide fallback for reliability:

```typescript
craft()
  .to(agent({
    fallbackEndpoint: 'default-handler'
  }))
```

### Custom System Prompt

Override routing instructions:

```typescript
craft()
  .to(agent({
    systemPrompt: `You are a specialized routing assistant.
Only route to fetch-content if the user provides a URL.
Otherwise, route to generate-letter.`
  }))
```
```

### Example Workflow

File: `packages/ai/examples/google-chat-assistant.ts`

```typescript
import { context, craft, direct } from '@routecraft/routecraft';
import { chat } from '@routecraft/google';
import { agent, llm, OpenAIProvider } from '@routecraft/ai';
import OpenAI from 'openai';
import { z } from 'zod';

// Configure OpenAI
const provider = new OpenAIProvider(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
);

// Define reusable routes
const routes = [
  // Fetch web content
  craft()
    .id('fetch-content')
    .from(direct('fetch-content', {
      description: 'Fetch and summarize web content from a URL',
      schema: z.object({ url: z.string().url() }),
      keywords: ['fetch', 'web', 'url', 'scrape']
    }))
    .process(llm({
      systemPrompt: 'You are a web content summarizer',
      userPrompt: (ex) => `Fetch and summarize: ${ex.body.url}`,
      outputSchema: z.object({ summary: z.string() })
    })),
  
  // Generate motivation letter
  craft()
    .id('generate-letter')
    .from(direct('generate-letter', {
      description: 'Generate a motivation letter from job description',
      schema: z.object({ 
        jobDescription: z.string(),
        cvPath: z.string()
      }),
      keywords: ['letter', 'motivation', 'job', 'application']
    }))
    .process(llm({
      systemPrompt: 'You are a professional letter writer',
      userPrompt: (ex) => 
        `Write a motivation letter for:\n${ex.body.jobDescription}\n\nCV: ${ex.body.cvPath}`,
      outputSchema: z.object({ letter: z.string() })
    })),
  
  // Google Chat assistant (routes to above)
  craft()
    .id('chat-assistant')
    .from(chat('/assistant'))
    .to(agent({
      allowlist: ['fetch-content', 'generate-letter'],
      fallbackEndpoint: 'help'
    })),
  
  // Help/fallback route
  craft()
    .id('help')
    .from(direct('help', {
      schema: z.object({})
    }))
    .transform(() => ({
      message: 'Available commands: fetch URL or generate letter'
    }))
];

// Start the context
const ctx = context()
  .store('routecraft.ai.provider', provider)
  .routes(routes)
  .build();

await ctx.start();
```

## Success Criteria

- ✅ agent() adapter implemented
- ✅ Auto-discovery from registry works
- ✅ Allowlist filtering functional
- ✅ Function calling integration complete
- ✅ Fallback handling robust
- ✅ Custom prompts supported
- ✅ All tests passing
- ✅ Documentation with examples complete

## Estimate

**Total: 6-8 hours**
- Agent adapter core: 3-4 hours
- Route discovery & filtering: 1-2 hours
- Testing: 2 hours
- Documentation: 1-2 hours
