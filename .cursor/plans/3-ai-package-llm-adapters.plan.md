# Plan 3: LLM Adapters (OpenAI, Google Gemini)

## Overview

Add LLM adapters to `@routecraft/ai` for processing and transforming messages using OpenAI (ChatGPT) and Google Gemini models. LLMs are used as processors/transformers in the middle of routes, not as sources or destinations.

**Status:** Ready after Plan 2  
**Depends on:** Plan 2 (AI Package with Tool Alias)  
**Estimate:** 6-8 hours

## Rationale

**Why `.process()` and `.transform()` only?**

LLMs don't make sense as sources or destinations:
- **Not a source**: LLMs don't generate messages on their own - they respond to prompts
- **Not a destination**: LLMs don't store or consume messages - they transform them

LLMs are processors that take input, reason about it, and produce output. They fit naturally as:
- `.process(llm(...))` - Process message with LLM, return structured output
- `.transform(llm(...))` - Transform message body using LLM

## Package Structure (additions)

```
packages/
  ai/
    src/
      index.ts           # Updated exports
      dsl.ts             # Existing tool()
      llm/
        index.ts         # LLM exports
        types.ts         # Provider interface, options
        processor.ts     # llm() processor adapter
        providers/
          openai.ts      # OpenAI/ChatGPT provider
          gemini.ts      # Google Gemini provider
    test/
      tool.test.ts       # Existing
      llm.test.ts        # LLM tests
```

## Implementation

### 1. Create src/llm/types.ts

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Message format for LLM conversations
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Response from an LLM provider
 */
export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls";
}

/**
 * Options for LLM completion
 */
export interface LLMCompletionOptions {
  /** Model identifier (e.g., "gpt-4o", "gemini-1.5-pro") */
  model: string;
  
  /** System prompt to set context */
  systemPrompt?: string;
  
  /** Temperature for response randomness (0-2) */
  temperature?: number;
  
  /** Maximum tokens to generate */
  maxTokens?: number;
  
  /** Output schema for structured responses (StandardSchema) */
  outputSchema?: StandardSchemaV1;
  
  /** Stop sequences */
  stop?: string[];
}

/**
 * Provider-agnostic LLM interface
 */
export interface LLMProvider {
  /** Provider identifier */
  readonly providerId: string;
  
  /**
   * Generate a completion from messages
   */
  complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): Promise<LLMResponse>;
  
  /**
   * Generate a structured completion with schema validation
   */
  completeStructured<T>(
    messages: LLMMessage[],
    options: LLMCompletionOptions & { outputSchema: StandardSchemaV1 },
  ): Promise<T>;
}

/**
 * Options for the llm() processor/transformer
 */
export interface LLMAdapterOptions {
  /** LLM provider instance */
  provider: LLMProvider;
  
  /** Model to use */
  model: string;
  
  /** System prompt */
  systemPrompt?: string;
  
  /** 
   * How to construct the user message from the exchange body.
   * - string: Use as template with {body} placeholder
   * - function: Custom message builder
   * @default Stringifies the body as JSON
   */
  prompt?: string | ((body: unknown) => string);
  
  /** Temperature (0-2) */
  temperature?: number;
  
  /** Max tokens */
  maxTokens?: number;
  
  /** Output schema for structured responses */
  outputSchema?: StandardSchemaV1;
}
```

### 2. Create src/llm/providers/openai.ts

```typescript
import type {
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  LLMResponse,
} from "../types.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface OpenAIProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  
  /** Base URL (for Azure OpenAI or proxies) */
  baseUrl?: string;
  
  /** Organization ID */
  organization?: string;
  
  /** Default model */
  defaultModel?: string;
}

/**
 * OpenAI/ChatGPT LLM provider
 */
export class OpenAIProvider implements LLMProvider {
  readonly providerId = "openai";
  
  private apiKey: string;
  private baseUrl: string;
  private organization?: string;
  private defaultModel: string;
  
  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.organization = options.organization;
    this.defaultModel = options.defaultModel ?? "gpt-4o-mini";
  }
  
  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.organization && { "OpenAI-Organization": this.organization }),
      },
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stop: options.stop,
        ...(options.outputSchema && {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "response",
              strict: true,
              schema: this.standardSchemaToJsonSchema(options.outputSchema),
            },
          },
        }),
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }
    
    const data = await response.json();
    const choice = data.choices[0];
    
    return {
      content: choice.message.content,
      usage: data.usage && {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      finishReason: choice.finish_reason,
    };
  }
  
  async completeStructured<T>(
    messages: LLMMessage[],
    options: LLMCompletionOptions & { outputSchema: StandardSchemaV1 },
  ): Promise<T> {
    const response = await this.complete(messages, options);
    const parsed = JSON.parse(response.content);
    
    // Validate against schema
    let result = options.outputSchema["~standard"].validate(parsed);
    if (result instanceof Promise) result = await result;
    
    if (result.issues) {
      throw new Error(
        `LLM response validation failed: ${JSON.stringify(result.issues)}`,
      );
    }
    
    return result.value as T;
  }
  
  /**
   * Convert StandardSchema to JSON Schema for OpenAI
   * This is a simplified conversion - real implementation would be more complete
   */
  private standardSchemaToJsonSchema(schema: StandardSchemaV1): object {
    // For now, check if the schema has a toJsonSchema method (some libs provide this)
    // Otherwise, we'd need to introspect the schema
    // This is a placeholder - real implementation depends on the schema library
    if ("toJsonSchema" in schema && typeof schema.toJsonSchema === "function") {
      return schema.toJsonSchema();
    }
    
    // Fallback: return a permissive object schema
    // Real implementation would convert StandardSchema to JSON Schema
    return { type: "object", additionalProperties: true };
  }
}
```

### 3. Create src/llm/providers/gemini.ts

```typescript
import type {
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  LLMResponse,
} from "../types.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface GeminiProviderOptions {
  /** Google AI API key */
  apiKey: string;
  
  /** Default model */
  defaultModel?: string;
}

/**
 * Google Gemini LLM provider
 */
export class GeminiProvider implements LLMProvider {
  readonly providerId = "gemini";
  
  private apiKey: string;
  private defaultModel: string;
  
  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? "gemini-1.5-flash";
  }
  
  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    
    // Convert messages to Gemini format
    const systemInstruction = messages.find((m) => m.role === "system");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents,
        ...(systemInstruction && {
          systemInstruction: { parts: [{ text: systemInstruction.content }] },
        }),
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
          stopSequences: options.stop,
          ...(options.outputSchema && {
            responseMimeType: "application/json",
            responseSchema: this.standardSchemaToGeminiSchema(options.outputSchema),
          }),
        },
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }
    
    const data = await response.json();
    const candidate = data.candidates[0];
    const content = candidate.content.parts[0].text;
    
    return {
      content,
      usage: data.usageMetadata && {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      },
      finishReason: this.mapFinishReason(candidate.finishReason),
    };
  }
  
  async completeStructured<T>(
    messages: LLMMessage[],
    options: LLMCompletionOptions & { outputSchema: StandardSchemaV1 },
  ): Promise<T> {
    const response = await this.complete(messages, options);
    const parsed = JSON.parse(response.content);
    
    // Validate against schema
    let result = options.outputSchema["~standard"].validate(parsed);
    if (result instanceof Promise) result = await result;
    
    if (result.issues) {
      throw new Error(
        `LLM response validation failed: ${JSON.stringify(result.issues)}`,
      );
    }
    
    return result.value as T;
  }
  
  private standardSchemaToGeminiSchema(schema: StandardSchemaV1): object {
    // Similar to OpenAI conversion
    if ("toJsonSchema" in schema && typeof schema.toJsonSchema === "function") {
      return schema.toJsonSchema();
    }
    return { type: "OBJECT" };
  }
  
  private mapFinishReason(
    reason: string,
  ): "stop" | "length" | "content_filter" | undefined {
    switch (reason) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
        return "content_filter";
      default:
        return undefined;
    }
  }
}
```

### 4. Create src/llm/processor.ts

```typescript
import type { Exchange } from "@routecraft/routecraft";
import type { LLMAdapterOptions, LLMMessage } from "./types.ts";

/**
 * Create an LLM processor for use with .process() or .transform()
 * 
 * @example
 * ```typescript
 * import { llm, OpenAIProvider } from '@routecraft/ai'
 * import { z } from 'zod'
 * 
 * const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY })
 * 
 * // Simple text transformation
 * craft()
 *   .from(source)
 *   .transform(llm({
 *     provider: openai,
 *     model: 'gpt-4o-mini',
 *     systemPrompt: 'You are a translator. Translate the input to French.',
 *   }))
 *   .to(destination)
 * 
 * // Structured output
 * craft()
 *   .from(source)
 *   .process(llm({
 *     provider: openai,
 *     model: 'gpt-4o',
 *     systemPrompt: 'Extract entities from the text.',
 *     outputSchema: z.object({
 *       people: z.array(z.string()),
 *       places: z.array(z.string()),
 *       organizations: z.array(z.string()),
 *     }),
 *   }))
 *   .to(destination)
 * ```
 */
export function llm<TInput = unknown, TOutput = string>(
  options: LLMAdapterOptions,
): (exchange: Exchange<TInput>) => Promise<TOutput> {
  return async (exchange: Exchange<TInput>): Promise<TOutput> => {
    const { provider, model, systemPrompt, prompt, temperature, maxTokens, outputSchema } = options;
    
    // Build user message from body
    let userContent: string;
    if (typeof prompt === "function") {
      userContent = prompt(exchange.body);
    } else if (typeof prompt === "string") {
      userContent = prompt.replace("{body}", JSON.stringify(exchange.body));
    } else {
      userContent = JSON.stringify(exchange.body);
    }
    
    // Build messages
    const messages: LLMMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userContent });
    
    // Call LLM
    if (outputSchema) {
      return provider.completeStructured<TOutput>(messages, {
        model,
        temperature,
        maxTokens,
        outputSchema,
      });
    } else {
      const response = await provider.complete(messages, {
        model,
        temperature,
        maxTokens,
      });
      return response.content as TOutput;
    }
  };
}
```

### 5. Create src/llm/index.ts

```typescript
export type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMCompletionOptions,
  LLMAdapterOptions,
} from "./types.ts";

export { llm } from "./processor.ts";
export { OpenAIProvider, type OpenAIProviderOptions } from "./providers/openai.ts";
export { GeminiProvider, type GeminiProviderOptions } from "./providers/gemini.ts";
```

### 6. Update src/index.ts

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

// Re-export relevant types from core
export type {
  DirectRouteMetadata,
  DirectAdapter,
  DirectAdapterOptions,
} from "@routecraft/routecraft";
```

### 7. Create test/llm.test.ts

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { llm, OpenAIProvider, GeminiProvider } from "../src/index.ts";
import type { LLMProvider, LLMMessage, LLMCompletionOptions } from "../src/index.ts";

// Mock provider for testing
class MockLLMProvider implements LLMProvider {
  readonly providerId = "mock";
  
  complete = vi.fn();
  completeStructured = vi.fn();
}

describe("llm() processor", () => {
  let mockProvider: MockLLMProvider;
  
  beforeEach(() => {
    mockProvider = new MockLLMProvider();
    mockProvider.complete.mockResolvedValue({
      content: "Bonjour le monde",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    mockProvider.completeStructured.mockResolvedValue({
      people: ["John"],
      places: ["Paris"],
    });
  });
  
  test("calls provider with correct messages", async () => {
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
      systemPrompt: "Translate to French",
    });
    
    const mockExchange = {
      body: "Hello world",
      headers: {},
    } as any;
    
    await processor(mockExchange);
    
    expect(mockProvider.complete).toHaveBeenCalledWith(
      [
        { role: "system", content: "Translate to French" },
        { role: "user", content: '"Hello world"' },
      ],
      expect.objectContaining({ model: "test-model" }),
    );
  });
  
  test("uses custom prompt function", async () => {
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
      prompt: (body) => `Process this: ${JSON.stringify(body)}`,
    });
    
    const mockExchange = {
      body: { message: "test" },
      headers: {},
    } as any;
    
    await processor(mockExchange);
    
    expect(mockProvider.complete).toHaveBeenCalledWith(
      [{ role: "user", content: 'Process this: {"message":"test"}' }],
      expect.anything(),
    );
  });
  
  test("uses template prompt with {body} placeholder", async () => {
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
      prompt: "Summarize: {body}",
    });
    
    const mockExchange = {
      body: "Long text here",
      headers: {},
    } as any;
    
    await processor(mockExchange);
    
    expect(mockProvider.complete).toHaveBeenCalledWith(
      [{ role: "user", content: 'Summarize: "Long text here"' }],
      expect.anything(),
    );
  });
  
  test("returns string response for unstructured output", async () => {
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
    });
    
    const mockExchange = { body: "test", headers: {} } as any;
    const result = await processor(mockExchange);
    
    expect(result).toBe("Bonjour le monde");
  });
  
  test("returns structured response when outputSchema provided", async () => {
    const schema = z.object({
      people: z.array(z.string()),
      places: z.array(z.string()),
    });
    
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
      outputSchema: schema,
    });
    
    const mockExchange = { body: "John went to Paris", headers: {} } as any;
    const result = await processor(mockExchange);
    
    expect(mockProvider.completeStructured).toHaveBeenCalled();
    expect(result).toEqual({ people: ["John"], places: ["Paris"] });
  });
  
  test("passes temperature and maxTokens to provider", async () => {
    const processor = llm({
      provider: mockProvider,
      model: "test-model",
      temperature: 0.5,
      maxTokens: 100,
    });
    
    const mockExchange = { body: "test", headers: {} } as any;
    await processor(mockExchange);
    
    expect(mockProvider.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        temperature: 0.5,
        maxTokens: 100,
      }),
    );
  });
});

describe("OpenAIProvider", () => {
  test("constructs with required options", () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
    });
    
    expect(provider.providerId).toBe("openai");
  });
  
  test("constructs with all options", () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseUrl: "https://custom.api.com",
      organization: "org-123",
      defaultModel: "gpt-4o",
    });
    
    expect(provider.providerId).toBe("openai");
  });
});

describe("GeminiProvider", () => {
  test("constructs with required options", () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
    });
    
    expect(provider.providerId).toBe("gemini");
  });
  
  test("constructs with all options", () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-1.5-pro",
    });
    
    expect(provider.providerId).toBe("gemini");
  });
});
```

## Update package.json

Add network dependency note:

```json
{
  "devDependencies": {
    "vitest": "^4.0.18",
    "zod": "^4.3.6"
  }
}
```

## Error Handling

Add new error code to core package (in a future PR or as part of this):

```typescript
// RC5012: LLM completion failed
RC5012: {
  category: "Adapter",
  message: "LLM completion failed",
  suggestion: "Check API key, model availability, and rate limits.",
  docs: `${DOCS_BASE}#rc-5012`,
  retryable: true,  // Network/rate limit errors may be retryable
}
```

## Success Criteria

- [ ] OpenAIProvider works with real API (manual test)
- [ ] GeminiProvider works with real API (manual test)
- [ ] `llm()` processor integrates with `.process()` and `.transform()`
- [ ] Structured output with schema validation works
- [ ] All unit tests pass with mocked providers
- [ ] TypeScript types are correct

## Next Steps

After this plan is complete:
- Plan 4: MCP Destination (`.to(mcp())`)
- Plan 5: MCP Source (`.from(mcp())`)
- Plan 6: Agent Routing
