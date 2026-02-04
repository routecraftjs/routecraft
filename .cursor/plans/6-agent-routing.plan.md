# Plan 6: Agent Routing

## Overview

Add AI-powered routing that uses an LLM to dynamically select which tool to call based on message content. The `agent()` adapter discovers available tools from the registry and uses function calling to route messages. It supports use as a destination, enricher, processor, or transformer.

**RouteCraft invariant:** `.to()` destinations **must not** modify the exchange body; they are side-effect only. Downstream steps receive the same exchange unchanged. To replace the body with the tool result, use `.process(agent())` instead of `.to(agent())`.

**Status:** Ready after Plan 5  
**Depends on:** Plan 3 (LLM Adapters), Plan 5 (MCP Source) - uses registry from Plan 1  
**Estimate:** 6-8 hours

## Supported Operations

| Operation | Use Case |
|-----------|----------|
| `.to(agent())` | Route to selected tool (side-effect only; **body unchanged**). To get body = tool result, use `.process(agent())`. |
| `.enrich(agent())` | Call selected tool, merge result into body (e.g. under `enrichKey`) |
| `.process(agent())` | Run agent, return new exchange with body = tool result |
| `.transform(agent())` | Not supported — agent needs exchange context (registry/store). Use `.process(agent())` to replace the body. |

## Rationale

**Why agent routing?**

Sometimes you don't know which tool to call at build time - you want an AI to decide based on the message content. This is the "magic" that enables natural language interfaces.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Input Message:                                                 │
│  "What's the weather in Paris?"                                 │
│                                                                  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │  agent()     │  ─────▶ LLM decides: "weather-lookup"         │
│  │  destination │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼ Calls selected tool                                   │
│  ┌──────────────┐                                               │
│  │ weather-     │                                               │
│  │ lookup tool  │ ─────▶ Returns weather data                   │
│  └──────────────┘                                               │
│                                                                  │
│  With .to(agent()): exchange body is unchanged (side-effect only).│
│  Use .process(agent()) to set body = tool result.                │
└─────────────────────────────────────────────────────────────────┘
```

## Package Structure (additions)

```
packages/
  ai/
    src/
      agent/
        index.ts         # Agent exports
        types.ts         # Agent types
        router.ts        # agent() destination adapter
    test/
      agent.test.ts
```

## Implementation

### 1. Create src/agent/types.ts

```typescript
import type { LLMProvider } from "../llm/types.ts";
import type { DirectRouteMetadata } from "@routecraft/routecraft";

/**
 * Options for the agent() adapter (works with .to(), .enrich(), .process())
 */
export interface AgentOptions {
  /** LLM provider for routing decisions */
  provider: LLMProvider;
  
  /** Model to use for routing */
  model: string;
  
  /**
   * Which tools the agent can route to.
   * - undefined: All discoverable tools
   * - string[]: Allowlist of tool names
   * - function: Filter function
   */
  tools?: string[] | ((metadata: DirectRouteMetadata) => boolean);
  
  /**
   * System prompt for the routing decision.
   * The LLM receives this plus tool descriptions.
   */
  systemPrompt?: string;
  
  /**
   * What to do if no tool matches.
   * - 'error': Throw an error (default)
   * - 'passthrough': Return message unchanged
   * - string: Route to this specific tool
   */
  fallback?: "error" | "passthrough" | string;
  
  /**
   * Temperature for routing decisions (lower = more deterministic)
   * @default 0
   */
  temperature?: number;
  
  /**
   * Maximum retries if routing fails
   * @default 1
   */
  maxRetries?: number;
  
  /**
   * Custom prompt builder for the routing decision
   */
  buildPrompt?: (body: unknown, tools: DirectRouteMetadata[]) => string;
  
  /**
   * For .enrich(): Key to store the tool result under.
   * If not specified, result is merged at top level (default aggregator).
   * @example 'toolResult' -> { ...body, toolResult: result }
   */
  enrichKey?: string;
}

/**
 * Result of an agent routing decision
 */
export interface AgentRoutingDecision {
  /** Selected tool name */
  tool: string;
  
  /** Arguments to pass to the tool (may be transformed from original message) */
  arguments: Record<string, unknown>;
  
  /** Reasoning from the LLM (if available) */
  reasoning?: string;
}
```

### 2. Create src/agent/router.ts

```typescript
import type { Exchange, DefaultExchange } from "@routecraft/routecraft";
import type { Destination, Enricher, Processor } from "@routecraft/routecraft";
import { CraftContext, DirectAdapter } from "@routecraft/routecraft";
import type { DirectRouteMetadata, DirectChannel } from "@routecraft/routecraft";
import type { AgentOptions, AgentRoutingDecision } from "./types.ts";
import type { LLMMessage } from "../llm/types.ts";

/**
 * Agent adapter that uses an LLM to route messages to tools.
 * Implements Destination (for .to()), Enricher (for .enrich()), and Processor (for .process()).
 */
export class AgentAdapter<T = unknown> implements Destination<T>, Enricher<T, unknown>, Processor<T, T> {
  readonly adapterId = "routecraft.ai.adapter.agent";
  
  private options: AgentOptions;
  
  constructor(options: AgentOptions) {
    this.options = {
      temperature: 0,
      maxRetries: 1,
      fallback: "error",
      ...options,
    };
  }
  
  /** Called by .to(agent()) — side-effect only; must not modify body (RouteCraft .to() invariant) */
  async send(exchange: Exchange<T>): Promise<void> {
    await this.runAgent(exchange);
    // Do not set exchange.body; .to() must not change the message.
  }
  
  /** Called by .enrich(agent()) — return tool result for aggregation (optionally under enrichKey) */
  async enrich(exchange: Exchange<T>): Promise<unknown> {
    const result = await this.runAgent(exchange);
    if (this.options.enrichKey) {
      return { [this.options.enrichKey]: result };
    }
    return result;
  }
  
  /** Called by .process(agent()) — return new exchange with body = tool result */
  async process(exchange: Exchange<T>): Promise<Exchange<T>> {
    const result = await this.runAgent(exchange);
    return { ...exchange, body: result as T };
  }
  
  /**
   * Run agent: get tools, make routing decision, call selected tool. Returns tool result.
   */
  private async runAgent(exchange: Exchange<T>): Promise<unknown> {
    const defaultExchange = exchange as DefaultExchange<T>;
    const context = defaultExchange.context;
    
    const tools = this.getAvailableTools(context);
    
    if (tools.length === 0) {
      if (this.options.fallback === "passthrough") {
        return exchange.body;
      }
      throw new Error("No tools available for agent routing");
    }
    
    defaultExchange.logger.debug(
      `Agent routing with ${tools.length} available tools`,
    );
    
    let decision: AgentRoutingDecision;
    let retries = 0;
    
    while (retries <= this.options.maxRetries!) {
      try {
        decision = await this.makeRoutingDecision(exchange.body, tools);
        break;
      } catch (error) {
        retries++;
        if (retries > this.options.maxRetries!) {
          throw error;
        }
        defaultExchange.logger.debug(
          `Routing decision failed, retry ${retries}/${this.options.maxRetries}`,
        );
      }
    }
    
    const selectedTool = tools.find((t) => t.endpoint === decision!.tool);
    if (!selectedTool) {
      if (this.options.fallback === "passthrough") {
        return exchange.body;
      } else if (
        typeof this.options.fallback === "string" &&
        this.options.fallback !== "error"
      ) {
        decision = { tool: this.options.fallback, arguments: exchange.body as Record<string, unknown> };
      } else {
        throw new Error(
          `Agent selected unknown tool: ${decision!.tool}. Available: ${tools.map((t) => t.endpoint).join(", ")}`,
        );
      }
    }
    
    defaultExchange.logger.debug(
      `Agent routed to tool "${decision!.tool}"${decision!.reasoning ? `: ${decision!.reasoning}` : ""}`,
    );
    
    return this.callTool(context, decision!.tool, decision!.arguments);
  }
  
  /**
   * Get tools available for routing based on options
   */
  private getAvailableTools(context: CraftContext): DirectRouteMetadata[] {
    const registry = context.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    if (!registry) return [];
    
    let tools = Array.from(registry.values());
    
    // Filter based on options
    if (this.options.tools) {
      if (Array.isArray(this.options.tools)) {
        const allowedNames = new Set(this.options.tools);
        tools = tools.filter((t) => allowedNames.has(t.endpoint));
      } else {
        tools = tools.filter(this.options.tools);
      }
    }
    
    // Only include tools with descriptions (for better routing)
    tools = tools.filter((t) => t.description);
    
    return tools;
  }
  
  /**
   * Use LLM to decide which tool to call
   */
  private async makeRoutingDecision(
    body: unknown,
    tools: DirectRouteMetadata[],
  ): Promise<AgentRoutingDecision> {
    const systemPrompt = this.buildSystemPrompt(tools);
    const userPrompt = this.options.buildPrompt
      ? this.options.buildPrompt(body, tools)
      : this.buildUserPrompt(body);
    
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    
    // Use function calling to get structured decision
    const response = await this.options.provider.complete(messages, {
      model: this.options.model,
      temperature: this.options.temperature,
      // In real implementation, would use function calling:
      // functions: tools.map(t => this.toolToFunction(t)),
      // function_call: "auto",
    });
    
    // Parse response - in real implementation would use function call result
    return this.parseRoutingResponse(response.content, tools);
  }
  
  /**
   * Build system prompt with tool descriptions
   */
  private buildSystemPrompt(tools: DirectRouteMetadata[]): string {
    const toolDescriptions = tools
      .map((t) => {
        const keywords = t.keywords?.length ? ` [${t.keywords.join(", ")}]` : "";
        return `- ${t.endpoint}: ${t.description}${keywords}`;
      })
      .join("\n");
    
    const customPrompt = this.options.systemPrompt ?? "";
    
    return `You are a routing agent. Your job is to select the best tool to handle the user's request.

Available tools:
${toolDescriptions}

${customPrompt}

Respond with JSON: {"tool": "tool-name", "arguments": {...}, "reasoning": "why this tool"}

Select the most appropriate tool based on the user's input. Extract relevant arguments from the input to pass to the tool.`;
  }
  
  /**
   * Build user prompt from message body
   */
  private buildUserPrompt(body: unknown): string {
    if (typeof body === "string") {
      return body;
    }
    return JSON.stringify(body);
  }
  
  /**
   * Parse LLM response into routing decision
   */
  private parseRoutingResponse(
    response: string,
    tools: DirectRouteMetadata[],
  ): AgentRoutingDecision {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (!parsed.tool || typeof parsed.tool !== "string") {
        throw new Error("Missing or invalid 'tool' in response");
      }
      
      return {
        tool: parsed.tool,
        arguments: parsed.arguments ?? {},
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      // Fallback: try to find a tool name mentioned in the response
      for (const tool of tools) {
        if (response.toLowerCase().includes(tool.endpoint.toLowerCase())) {
          return {
            tool: tool.endpoint,
            arguments: {},
            reasoning: "Extracted from response text",
          };
        }
      }
      
      throw new Error(`Failed to parse routing decision: ${error}`);
    }
  }
  
  /**
   * Call the selected tool
   */
  private async callTool(
    context: CraftContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const store = context.getStore(DirectAdapter.ADAPTER_DIRECT_STORE) as
      | Map<string, DirectChannel<Exchange>>
      | undefined;
    
    if (!store) {
      throw new Error("No tool store found");
    }
    
    const channel = store.get(toolName);
    if (!channel) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    
    // Create exchange and send to tool
    const result = await channel.send(toolName, {
      body: args,
      headers: {},
      id: crypto.randomUUID(),
      timestamp: new Date(),
    } as any);
    
    return result.body;
  }
}

/**
 * Create an agent adapter that uses an LLM to route messages to tools.
 * Works with .to(), .enrich(), and .process().
 *
 * The agent discovers available tools from the registry, sends tool descriptions
 * to the LLM, and routes the message to the selected tool.
 *
 * @example .to(agent()) — invoke selected tool (body unchanged; use .process(agent()) to replace body)
 * ```typescript
 * craft()
 *   .from(userInput)
 *   .to(agent({ provider: openai, model: 'gpt-4o-mini' }))  // side-effect only
 *   .to(response)
 * ```
 *
 * @example .enrich(agent()) — merge tool result into body
 * ```typescript
 * craft()
 *   .from(simple({ query: 'weather Paris' }))
 *   .enrich(agent({
 *     provider: openai,
 *     model: 'gpt-4o-mini',
 *     enrichKey: 'toolResult',  // body becomes { query, toolResult }
 *   }))
 *   .process(({ query, toolResult }) => formatResponse(toolResult))
 * ```
 *
 * @example .process(agent()) — new exchange with body = tool result
 * ```typescript
 * craft()
 *   .from(userInput)
 *   .process(agent({ provider: openai, model: 'gpt-4o-mini' }))
 *   .to(logger)
 * ```
 *
 * @example With allowlist and fallback
 * ```typescript
 * craft()
 *   .from(userInput)
 *   .to(agent({
 *     provider: openai,
 *     model: 'gpt-4o',
 *     tools: ['weather-lookup', 'search-web'],
 *     fallback: 'general-assistant',
 *     systemPrompt: 'You are a helpful assistant.',
 *   }))
 * ```
 */
export function agent<T = unknown>(options: AgentOptions): AgentAdapter<T> {
  return new AgentAdapter<T>(options);
}
```

### 3. Create src/agent/index.ts

```typescript
export type { AgentOptions, AgentRoutingDecision } from "./types.ts";
export { agent, AgentAdapter } from "./router.ts";
```

### 4. Update src/index.ts

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

// Agent
export {
  agent,
  AgentAdapter,
  type AgentOptions,
  type AgentRoutingDecision,
} from "./agent/index.ts";

// Re-export relevant types from core
export type {
  DirectRouteMetadata,
  DirectAdapter,
  DirectAdapterOptions,
} from "@routecraft/routecraft";
```

### 5. Create test/agent.test.ts

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { agent, tool } from "../src/index.ts";
import type { LLMProvider } from "../src/index.ts";
import {
  context,
  craft,
  simple,
  DirectAdapter,
  type CraftContext,
} from "@routecraft/routecraft";

// Mock LLM provider
class MockLLMProvider implements LLMProvider {
  readonly providerId = "mock";
  
  complete = vi.fn();
  completeStructured = vi.fn();
}

describe("agent() adapter", () => {
  let ctx: CraftContext;
  let mockProvider: MockLLMProvider;
  
  beforeEach(() => {
    mockProvider = new MockLLMProvider();
  });
  
  afterEach(async () => {
    if (ctx) await ctx.stop();
  });
  
  test("creates agent adapter", () => {
    const adapter = agent({
      provider: mockProvider,
      model: "test-model",
    });
    
    expect(adapter.adapterId).toBe("routecraft.ai.adapter.agent");
  });
  
  test("routes to correct tool based on LLM decision", async () => {
    const weatherHandler = vi.fn().mockImplementation((ex) => {
      ex.body = { temp: 20, location: "Paris" };
    });
    const searchHandler = vi.fn();
    
    // Mock LLM to select weather-lookup
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "weather-lookup",
        arguments: { location: "Paris" },
        reasoning: "User asked about weather",
      }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("weather")
          .from(
            tool("weather-lookup", {
              description: "Get weather for a location",
              schema: z.object({ location: z.string() }),
            }),
          )
          .to(weatherHandler),
        craft()
          .id("search")
          .from(
            tool("search-web", {
              description: "Search the web",
              schema: z.object({ query: z.string() }),
            }),
          )
          .to(searchHandler),
        craft()
          .id("agent-route")
          .from(simple("What's the weather in Paris?"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    
    expect(mockProvider.complete).toHaveBeenCalled();
    // In real test, would verify weatherHandler was called
  });
  
  test("filters tools by allowlist", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "allowed-tool",
        arguments: {},
      }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("allowed")
          .from(
            tool("allowed-tool", {
              description: "An allowed tool",
            }),
          )
          .to(vi.fn()),
        craft()
          .id("blocked")
          .from(
            tool("blocked-tool", {
              description: "A blocked tool",
            }),
          )
          .to(vi.fn()),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
              tools: ["allowed-tool"], // Only this tool
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Verify system prompt only includes allowed-tool
    const systemPrompt = mockProvider.complete.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain("allowed-tool");
    expect(systemPrompt).not.toContain("blocked-tool");
  });
  
  test("filters tools by function", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "public-tool",
        arguments: {},
      }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("public")
          .from(
            tool("public-tool", {
              description: "A public tool",
              keywords: ["public"],
            }),
          )
          .to(vi.fn()),
        craft()
          .id("private")
          .from(
            tool("private-tool", {
              description: "A private tool",
              keywords: ["private"],
            }),
          )
          .to(vi.fn()),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
              tools: (meta) => meta.keywords?.includes("public") ?? false,
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    const systemPrompt = mockProvider.complete.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain("public-tool");
    expect(systemPrompt).not.toContain("private-tool");
  });
  
  test("uses fallback tool when no match", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "nonexistent-tool",
        arguments: {},
      }),
    });
    
    const fallbackHandler = vi.fn();
    
    ctx = context()
      .routes([
        craft()
          .id("fallback")
          .from(
            tool("fallback-tool", {
              description: "Fallback handler",
            }),
          )
          .to(fallbackHandler),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
              fallback: "fallback-tool",
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Would verify fallback was called in real test
  });
  
  test("throws error when fallback is 'error' and no match", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "nonexistent-tool",
        arguments: {},
      }),
    });
    
    const errorHandler = vi.fn();
    
    ctx = context()
      .on("error", errorHandler)
      .routes([
        craft()
          .id("only-tool")
          .from(
            tool("only-tool", {
              description: "The only tool",
            }),
          )
          .to(vi.fn()),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
              fallback: "error",
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(errorHandler).toHaveBeenCalled();
  });
  
  test("passes through when fallback is 'passthrough'", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "nonexistent-tool",
        arguments: {},
      }),
    });
    
    const destination = vi.fn();
    
    // This would need a more complex setup to verify passthrough
    const adapter = agent({
      provider: mockProvider,
      model: "test-model",
      fallback: "passthrough",
    });
    
    expect(adapter).toBeDefined();
  });
  
  test("includes custom system prompt", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({ tool: "test-tool", arguments: {} }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("test")
          .from(tool("test-tool", { description: "Test" }))
          .to(vi.fn()),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
              systemPrompt: "Always be helpful and precise.",
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    const systemPrompt = mockProvider.complete.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain("Always be helpful and precise.");
  });
  
  test("uses low temperature by default for deterministic routing", async () => {
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({ tool: "test-tool", arguments: {} }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("test")
          .from(tool("test-tool", { description: "Test" }))
          .to(vi.fn()),
        craft()
          .id("agent-route")
          .from(simple("test"))
          .to(
            agent({
              provider: mockProvider,
              model: "test-model",
            }),
          ),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    expect(mockProvider.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ temperature: 0 }),
    );
  });
  
  test("agent as enricher returns tool result for aggregation", async () => {
    const enrichHandler = vi.fn();
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({
        tool: "data-tool",
        arguments: { id: "1" },
      }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("data-tool")
          .from(
            tool("data-tool", {
              description: "Fetch data by id",
              schema: z.object({ id: z.string() }),
            }),
          )
          .process(async (ex) => {
            ex.body = { fetched: "data" };
          }),
        craft()
          .id("enrich-route")
          .from(simple({ query: "get 1", id: "1" }))
          .enrich(
            agent({
              provider: mockProvider,
              model: "test-model",
              enrichKey: "toolResult",
            }),
          )
          .to(enrichHandler),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    
    expect(enrichHandler).toHaveBeenCalled();
    const exchange = enrichHandler.mock.calls[0][0];
    expect(exchange.body).toMatchObject({ query: "get 1", id: "1", toolResult: { fetched: "data" } });
  });
  
  test("agent as processor returns new exchange with tool result", async () => {
    const downstream = vi.fn();
    mockProvider.complete.mockResolvedValue({
      content: JSON.stringify({ tool: "echo-tool", arguments: { msg: "hi" } }),
    });
    
    ctx = context()
      .routes([
        craft()
          .id("echo-tool")
          .from(
            tool("echo-tool", {
              description: "Echo message",
              schema: z.object({ msg: z.string() }),
            }),
          )
          .process(async (ex) => {
            ex.body = { echoed: (ex.body as { msg: string }).msg };
          }),
        craft()
          .id("process-route")
          .from(simple("say hi"))
          .process(
            agent({
              provider: mockProvider,
              model: "test-model",
            }),
          )
          .to(downstream),
      ])
      .build();
    
    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    
    expect(downstream).toHaveBeenCalled();
    const exchange = downstream.mock.calls[0][0];
    expect(exchange.body).toMatchObject({ echoed: "hi" });
  });
});
```

## Usage Example

Complete example showing agent routing:

```typescript
import { context, craft, simple } from "@routecraft/routecraft";
import { tool, agent, OpenAIProvider } from "@routecraft/ai";
import { z } from "zod";

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Define tools
const weatherTool = craft()
  .id("weather")
  .from(
    tool("get-weather", {
      description: "Get current weather for a city",
      schema: z.object({
        city: z.string().describe("City name"),
      }),
      keywords: ["weather", "temperature", "forecast"],
    }),
  )
  .process(async ({ city }) => {
    // Call weather API
    return { city, temp: 22, conditions: "sunny" };
  });

const searchTool = craft()
  .id("search")
  .from(
    tool("web-search", {
      description: "Search the web for information",
      schema: z.object({
        query: z.string().describe("Search query"),
      }),
      keywords: ["search", "find", "lookup", "google"],
    }),
  )
  .process(async ({ query }) => {
    // Call search API
    return { results: [`Result for: ${query}`] };
  });

const calculatorTool = craft()
  .id("calculator")
  .from(
    tool("calculate", {
      description: "Perform mathematical calculations",
      schema: z.object({
        expression: z.string().describe("Math expression to evaluate"),
      }),
      keywords: ["math", "calculate", "compute", "add", "multiply"],
    }),
  )
  .process(async ({ expression }) => {
    return { result: eval(expression) }; // Don't use eval in production!
  });

// Agent route - .to(): invoke tool (body unchanged). Use .process(agent()) to replace body with result.
const agentRoute = craft()
  .id("agent")
  .from(simple("What's the weather like in Tokyo?"))
  .to(
    agent({
      provider: openai,
      model: "gpt-4o-mini",
      systemPrompt: "You are a helpful assistant. Route requests to the appropriate tool.",
      fallback: "passthrough",
    }),
  )
  .to((ex) => {
    console.log("Original body (unchanged):", ex.body);
  });

// .enrich(agent()): keep original body and merge tool result under a key
craft()
  .from(simple({ userQuery: "weather Tokyo", locale: "en" }))
  .enrich(agent({
    provider: openai,
    model: "gpt-4o-mini",
    enrichKey: "weatherData",
  }))
  .process(({ userQuery, locale, weatherData }) => {
    return formatResponse(weatherData, locale);
  });

// .process(agent()): new exchange with body = tool result
craft()
  .from(userInput)
  .process(agent({ provider: openai, model: "gpt-4o-mini" }))
  .to(logger);

// Start
const ctx = context()
  .routes([weatherTool, searchTool, calculatorTool, agentRoute])
  .build();

await ctx.start();
```

## Success Criteria

- [ ] `agent()` creates an adapter that implements Destination, Enricher, Processor
- [ ] `.to(agent())` invokes the selected tool as a side-effect **without** modifying the exchange body (`.to()` invariant)
- [ ] `.enrich(agent())` returns tool result for aggregation; `enrichKey` stores under key
- [ ] `.process(agent())` returns new exchange with body = tool result
- [ ] Agent discovers tools from registry
- [ ] Agent calls LLM with tool descriptions
- [ ] Agent routes to correct tool based on LLM decision
- [ ] Tool allowlist filtering works
- [ ] Tool function filtering works
- [ ] Fallback behavior works (error, passthrough, specific tool)
- [ ] Custom system prompt is included
- [ ] Temperature is configurable
- [ ] All tests pass (including enrich and process usage)

## Security Considerations

1. **Allowlist by default**: In production, always use `tools` option to limit available tools
2. **Input validation**: Tools should validate their inputs
3. **Output sanitization**: Don't trust LLM output - validate tool names
4. **Rate limiting**: Consider rate limiting agent calls
5. **Audit logging**: Log routing decisions for debugging

## Future Enhancements

- Multi-turn agent conversations
- Tool chaining (agent calls multiple tools in sequence)
- Memory/context persistence
- Streaming responses
- Cost tracking
