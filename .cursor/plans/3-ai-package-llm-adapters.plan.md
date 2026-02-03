---
name: AI Package LLM Adapters
overview: Add LLM provider interface and llm() processor/transformer adapters to @routecraft/ai for AI-powered message processing and transformation.
dependencies:
  - Plan 2 (AI Package MCP Adapters) must be merged first - extends existing package
todos:
  - id: llm-provider-interface
    content: Create LLMProvider interface and base types
    status: pending
  - id: openai-provider
    content: Implement OpenAI provider with completions and structured outputs
    status: pending
  - id: llm-processor
    content: Create llm() processor adapter for full exchange transformation
    status: pending
  - id: llm-transformer
    content: Create llm() transformer adapter for body-only transformation
    status: pending
  - id: context-store-integration
    content: Add provider configuration to context store
    status: pending
  - id: llm-tests
    content: Write tests with mock provider
    status: pending
  - id: llm-docs
    content: Update documentation with LLM examples
    status: pending
---

# AI Package: LLM Adapters

## Overview

Add LLM (Large Language Model) integration to `@routecraft/ai` package:

1. **Provider-agnostic interface** - Support any LLM provider (OpenAI, Anthropic, etc.)
2. **llm() processor** - Full exchange transformation with LLM
3. **llm() transformer** - Body-only transformation (simpler)

## Why This is Separate

LLM features are **independent** from MCP integration. Can be used without MCP for:
- Content transformation
- Text generation
- Data enrichment
- Translation/summarization

## Dependency

**Extends Plan 2 (AI Package MCP Adapters)** - adds to existing `@routecraft/ai` package.

## Implementation

### 1. LLM Provider Interface

File: `packages/ai/src/providers/base.ts`

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Provider-agnostic interface for LLM interactions.
 * Implement this to support any LLM provider.
 */
export interface LLMProvider {
  /** Generate text completion with optional structured output */
  complete(options: CompletionOptions): Promise<CompletionResult>;
  
  /** Function calling (used by agent() - will be in Plan 4) */
  functionCall?(options: FunctionCallOptions): Promise<FunctionCallResult>;
}

export interface CompletionOptions {
  /** System prompt to set context/behavior */
  systemPrompt?: string;
  
  /** User prompt with the actual request */
  userPrompt: string;
  
  /** Zod schema for structured JSON output */
  outputSchema?: StandardSchemaV1;
  
  /** Temperature (0.0-2.0, lower = more deterministic) */
  temperature?: number;
  
  /** Maximum tokens to generate */
  maxTokens?: number;
  
  /** Model identifier (provider-specific) */
  model?: string;
}

export interface CompletionResult {
  /** Generated content */
  content: string;
  
  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Function calling types (for future agent() adapter)
export interface FunctionCallOptions {
  systemPrompt?: string;
  userPrompt: string;
  functions: FunctionDefinition[];
  model?: string;
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

export interface FunctionCallResult {
  functionName: string;
  arguments: Record<string, any>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

### 2. OpenAI Provider

File: `packages/ai/src/providers/openai.ts`

```typescript
import OpenAI from 'openai';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
  FunctionCallOptions,
  FunctionCallResult
} from './base';
import { zodToJsonSchema } from '../utils/schema';

export class OpenAIProvider implements LLMProvider {
  constructor(
    private client: OpenAI,
    private defaultModel = 'gpt-4o-mini'
  ) {}
  
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: options.userPrompt });
    
    const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    };
    
    // Structured outputs via response_format
    if (options.outputSchema) {
      requestOptions.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: zodToJsonSchema(options.outputSchema)
        }
      };
    }
    
    const completion = await this.client.chat.completions.create(requestOptions);
    
    return {
      content: completion.choices[0].message.content || '',
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens
      } : undefined
    };
  }
  
  async functionCall(options: FunctionCallOptions): Promise<FunctionCallResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: options.userPrompt });
    
    const completion = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages,
      tools: options.functions.map(f => ({
        type: 'function',
        function: {
          name: f.name,
          description: f.description,
          parameters: f.parameters
        }
      })),
      tool_choice: 'required'
    });
    
    const toolCall = completion.choices[0].message.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new Error('No function call in response');
    }
    
    return {
      functionName: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments),
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens
      } : undefined
    };
  }
}
```

### 3. LLM Adapters

File: `packages/ai/src/adapters/llm.ts`

```typescript
import type { Processor, Transformer, Exchange, CraftContext } from '@routecraft/routecraft';
import type { LLMProvider } from '../providers/base';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Options for llm() when used with .process()
 */
export interface LLMProcessorOptions<T = unknown, R = unknown> {
  /** System prompt (static or derived from exchange) */
  systemPrompt: string | ((exchange: Exchange<T>) => string | Promise<string>);
  
  /** User prompt (defaults to JSON.stringify(body)) */
  userPrompt?: string | ((exchange: Exchange<T>) => string | Promise<string>);
  
  /** Zod schema for structured output */
  outputSchema?: StandardSchemaV1;
  
  /** LLM provider (defaults to context store) */
  provider?: LLMProvider;
  
  /** Temperature for generation */
  temperature?: number;
  
  /** Model to use */
  model?: string;
  
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * Options for llm() when used with .transform()
 */
export interface LLMTransformerOptions<T = unknown, R = unknown> {
  /** System prompt (static or derived from body) */
  systemPrompt: string | ((body: T) => string | Promise<string>);
  
  /** User prompt (defaults to JSON.stringify(body)) */
  userPrompt?: string | ((body: T) => string | Promise<string>);
  
  /** Zod schema for structured output */
  outputSchema?: StandardSchemaV1;
  
  /** LLM provider (REQUIRED for transformer - no context access) */
  provider: LLMProvider;
  
  /** Temperature for generation */
  temperature?: number;
  
  /** Model to use */
  model?: string;
  
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * LLM processor adapter for full exchange transformation.
 * 
 * @example
 * craft()
 *   .from(source)
 *   .process(llm({
 *     systemPrompt: 'You are a translator',
 *     userPrompt: (ex) => `Translate to French: ${ex.body.text}`,
 *     outputSchema: z.object({ translation: z.string() })
 *   }))
 */
export class LLMProcessor<T = unknown, R = unknown> implements Processor<T, R> {
  readonly adapterId = 'routecraft.ai.llm.processor';
  
  constructor(private options: LLMProcessorOptions<T, R>) {}
  
  async process(exchange: Exchange<T>): Promise<Exchange<R>> {
    const context = (exchange as any).context as CraftContext;
    const provider = this.getProvider(context);
    
    const systemPrompt = typeof this.options.systemPrompt === 'function'
      ? await this.options.systemPrompt(exchange)
      : this.options.systemPrompt;
      
    const userPrompt = this.options.userPrompt
      ? (typeof this.options.userPrompt === 'function'
          ? await this.options.userPrompt(exchange)
          : this.options.userPrompt)
      : JSON.stringify(exchange.body);
    
    const result = await provider.complete({
      systemPrompt,
      userPrompt,
      outputSchema: this.options.outputSchema,
      temperature: this.options.temperature,
      model: this.options.model,
      maxTokens: this.options.maxTokens
    });
    
    const body = this.options.outputSchema
      ? JSON.parse(result.content)
      : result.content;
    
    return {
      ...exchange,
      body: body as R
    };
  }
  
  private getProvider(context: CraftContext): LLMProvider {
    const provider = this.options.provider || 
      context.getStore('routecraft.ai.provider');
    if (!provider) {
      throw new Error('No LLM provider configured. Add provider to context store or options.');
    }
    return provider;
  }
}

/**
 * LLM transformer adapter for body-only transformation.
 * 
 * @example
 * craft()
 *   .from(source)
 *   .transform(llm({
 *     provider: openaiProvider,
 *     systemPrompt: 'You are a poet',
 *     outputSchema: z.object({ poem: z.string() })
 *   }))
 */
export class LLMTransformer<T = unknown, R = unknown> implements Transformer<T, R> {
  readonly adapterId = 'routecraft.ai.llm.transformer';
  
  constructor(private options: LLMTransformerOptions<T, R>) {}
  
  async transform(body: T): Promise<R> {
    // Transformer doesn't have access to context
    // Provider must be provided in options
    if (!this.options.provider) {
      throw new Error('LLM transformer requires provider in options (no context access)');
    }
    
    const systemPrompt = typeof this.options.systemPrompt === 'function'
      ? await this.options.systemPrompt(body)
      : this.options.systemPrompt;
      
    const userPrompt = this.options.userPrompt
      ? (typeof this.options.userPrompt === 'function'
          ? await this.options.userPrompt(body)
          : this.options.userPrompt)
      : JSON.stringify(body);
    
    const result = await this.options.provider.complete({
      systemPrompt,
      userPrompt,
      outputSchema: this.options.outputSchema,
      temperature: this.options.temperature,
      model: this.options.model,
      maxTokens: this.options.maxTokens
    });
    
    return this.options.outputSchema
      ? JSON.parse(result.content)
      : result.content as R;
  }
}

/**
 * Factory function that returns appropriate adapter based on options.
 * TypeScript will infer correct usage based on context.
 */
export function llm<T = unknown, R = unknown>(
  options: LLMProcessorOptions<T, R>
): LLMProcessor<T, R>;

export function llm<T = unknown, R = unknown>(
  options: LLMTransformerOptions<T, R>
): LLMTransformer<T, R>;

export function llm<T = unknown, R = unknown>(
  options: LLMProcessorOptions<T, R> | LLMTransformerOptions<T, R>
): LLMProcessor<T, R> | LLMTransformer<T, R> {
  // Check if provider is required (transformer) or optional (processor)
  if ('provider' in options && options.provider) {
    // Could be either, default to processor for now
    return new LLMProcessor(options as LLMProcessorOptions<T, R>);
  }
  return new LLMProcessor(options as LLMProcessorOptions<T, R>);
}
```

### 4. Context Store Integration

File: `packages/ai/src/types.ts`

```typescript
import type { LLMProvider } from './providers/base';

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    /** LLM provider for AI adapters */
    "routecraft.ai.provider": LLMProvider;
    
    /** Default model for AI operations */
    "routecraft.ai.defaultModel"?: string;
    
    /** Default temperature for AI operations */
    "routecraft.ai.defaultTemperature"?: number;
  }
}
```

### 5. Update Package Exports

File: `packages/ai/src/index.ts`

```typescript
// MCP adapters (from Plan 2)
export { mcp } from './adapters/mcp';
export type { McpSourceOptions, McpDestinationOptions } from './adapters/mcp';

// LLM adapters (NEW)
export { llm } from './adapters/llm';
export type { LLMProcessorOptions, LLMTransformerOptions } from './adapters/llm';

// Providers (NEW)
export { OpenAIProvider } from './providers/openai';
export type { LLMProvider, CompletionOptions, CompletionResult } from './providers/base';

// MCP server/client
export { McpServer } from './mcp/server';
export { McpClient } from './mcp/client';
export type { McpClientOptions, McpTool } from './mcp/client';

// Utilities
export { zodToJsonSchema } from './utils/schema';
```

### 6. Update Package Dependencies

File: `packages/ai/package.json`

Add OpenAI as peer dependency:

```json
{
  "peerDependencies": {
    "openai": "^4.0.0",
    "zod": "^3.22.0"
  },
  "peerDependenciesMeta": {
    "openai": { "optional": true }
  }
}
```

## Testing

### Mock Provider

File: `packages/ai/test/mocks/provider.ts`

```typescript
import type { LLMProvider, CompletionOptions, CompletionResult } from '../../src/providers/base';

export class MockLLMProvider implements LLMProvider {
  constructor(private responses: Map<string, string> = new Map()) {}
  
  setResponse(prompt: string, response: string) {
    this.responses.set(prompt, response);
  }
  
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const response = this.responses.get(options.userPrompt) || 'mock response';
    
    return {
      content: response,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30
      }
    };
  }
}
```

### LLM Processor Tests

File: `packages/ai/test/llm-processor.test.ts`

```typescript
import { expect, test } from "vitest";
import { context, craft, simple } from "@routecraft/routecraft";
import { llm } from "@routecraft/ai";
import { MockLLMProvider } from "./mocks/provider";
import { z } from "zod";

test("llm processor transforms exchange with LLM", async () => {
  const provider = new MockLLMProvider();
  provider.setResponse(
    JSON.stringify({ text: 'hello' }),
    JSON.stringify({ translation: 'bonjour' })
  );
  
  const result = vi.fn();
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .routes(
      craft()
        .id('translate')
        .from(simple({ text: 'hello' }))
        .process(llm({
          systemPrompt: 'You are a translator',
          outputSchema: z.object({ translation: z.string() })
        }))
        .to(result)
    )
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(result).toHaveBeenCalledTimes(1);
  expect(result.mock.calls[0][0].body).toEqual({ translation: 'bonjour' });
});

test("llm processor uses custom prompts", async () => {
  const provider = new MockLLMProvider();
  const completeSpy = vi.spyOn(provider, 'complete');
  
  const ctx = context()
    .store('routecraft.ai.provider', provider)
    .routes(
      craft()
        .from(simple({ name: 'Alice' }))
        .process(llm({
          systemPrompt: 'You are helpful',
          userPrompt: (ex) => `Greet ${ex.body.name}`
        }))
        .to(vi.fn())
    )
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(completeSpy).toHaveBeenCalled();
  const call = completeSpy.mock.calls[0][0];
  expect(call.systemPrompt).toBe('You are helpful');
  expect(call.userPrompt).toBe('Greet Alice');
});
```

### LLM Transformer Tests

File: `packages/ai/test/llm-transformer.test.ts`

```typescript
import { expect, test } from "vitest";
import { context, craft, simple } from "@routecraft/routecraft";
import { llm, LLMTransformer } from "@routecraft/ai";
import { MockLLMProvider } from "./mocks/provider";
import { z } from "zod";

test("llm transformer transforms body", async () => {
  const provider = new MockLLMProvider();
  provider.setResponse(
    '"hello"',
    JSON.stringify({ poem: 'Roses are red' })
  );
  
  const transformer = new LLMTransformer({
    provider,
    systemPrompt: 'You are a poet',
    outputSchema: z.object({ poem: z.string() })
  });
  
  const result = await transformer.transform('hello');
  
  expect(result).toEqual({ poem: 'Roses are red' });
});

test("llm transformer requires provider in options", async () => {
  const transformer = new LLMTransformer({
    provider: undefined as any,
    systemPrompt: 'test'
  });
  
  await expect(transformer.transform('test')).rejects.toThrow(
    'LLM transformer requires provider'
  );
});
```

## Documentation

### Update README

File: `packages/ai/README.md`

Add LLM section:

```markdown
## LLM Integration

### Process with LLM

Transform exchanges using Large Language Models:

```typescript
import { llm, OpenAIProvider } from '@routecraft/ai';
import OpenAI from 'openai';
import { z } from 'zod';

// Configure provider
const provider = new OpenAIProvider(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
);

const ctx = context()
  .store('routecraft.ai.provider', provider)
  .routes(
    craft()
      .from(source)
      .process(llm({
        systemPrompt: 'You are a translator',
        userPrompt: (ex) => `Translate to French: ${ex.body.text}`,
        outputSchema: z.object({ translation: z.string() })
      }))
  )
  .build();
```

### Transform with LLM

Body-only transformation (requires provider in options):

```typescript
craft()
  .from(source)
  .transform(llm({
    provider,
    systemPrompt: 'You are a poet',
    outputSchema: z.object({ 
      poem: z.string(),
      style: z.string()
    })
  }))
```

### Custom Providers

Implement `LLMProvider` interface for other providers:

```typescript
import type { LLMProvider } from '@routecraft/ai';

class AnthropicProvider implements LLMProvider {
  async complete(options) {
    // Implement using Anthropic SDK
  }
}
```
```

## Success Criteria

- ✅ LLMProvider interface defined
- ✅ OpenAI provider implemented
- ✅ llm() processor works with .process()
- ✅ llm() transformer works with .transform()
- ✅ Structured outputs via Zod schemas
- ✅ Context store integration
- ✅ All tests passing
- ✅ Documentation complete

## Estimate

**Total: 6-8 hours**
- Provider interface: 1 hour
- OpenAI provider: 2-3 hours
- llm() adapters: 2-3 hours
- Testing: 1-2 hours
- Documentation: 1 hour
