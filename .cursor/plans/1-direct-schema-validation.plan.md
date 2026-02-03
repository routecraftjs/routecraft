# Direct Route Schema Validation & AI Discoverability

## Overview

Enhance direct routes with Zod schema validation and optional metadata for AI discoverability. This provides:

1. **Type safety** - Validate body and headers on consumer side
2. **AI readiness** - Routes with descriptions become discoverable by AI agents
3. **No breaking changes** - All new fields are optional

## Why This is Separate

This is **core functionality** that future AI features depend on, but is valuable on its own for validation. Can be merged independently.

## Changes

### 1. Update DirectAdapterOptions

File: `packages/routecraft/src/adapters/direct.ts`

**Add new fields:**

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface DirectAdapterOptions {
  /** Existing field */
  channelType?: DirectChannelType<DirectChannel>;
  
  /** NEW: Zod schema for body validation (validated on consumer side) */
  schema?: StandardSchemaV1;
  
  /** NEW: Zod schemas for specific header validation */
  headerSchema?: Record<string, StandardSchemaV1>;
  
  /** 
   * NEW: Human-readable description of what this route does.
   * Makes route discoverable by AI agents (future feature).
   * Optional - only provide if route should be AI-callable.
   */
  description?: string;
  
  /** NEW: Keywords to help AI routing decisions (used with description) */
  keywords?: string[];
}
```

### 2. Create Route Registry

**Add new store type:**

```typescript
declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [DirectAdapter.ADAPTER_DIRECT_REGISTRY]: Map<string, DirectRouteMetadata>;
  }
}

interface DirectRouteMetadata {
  endpoint: string;
  description?: string;
  schema?: StandardSchemaV1;
  keywords?: string[];
}
```

**Add constant:**

```typescript
export class DirectAdapter<T = unknown> {
  // Existing
  static readonly ADAPTER_DIRECT_STORE = "routecraft.adapter.direct.store" as const;
  static readonly ADAPTER_DIRECT_OPTIONS = "routecraft.adapter.direct.options" as const;
  
  // NEW
  static readonly ADAPTER_DIRECT_REGISTRY = "routecraft.adapter.direct.registry" as const;
}
```

### 3. Implement Validation Logic

**Update `subscribe()` method:**

```typescript
async subscribe(
  context: CraftContext,
  handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
  abortController: AbortController,
): Promise<void> {
  if (typeof this.rawEndpoint === "function") {
    throw error("RC5010", undefined, {
      message: "Dynamic endpoints cannot be used as source",
      suggestion: '...'
    });
  }

  const endpoint = this.rawEndpoint.replace(/[^a-zA-Z0-9]/g, "-");
  
  // NEW: Register route if it has description (AI-discoverable)
  if (this.options.description) {
    this.registerRoute(context, endpoint);
  }

  context.logger.debug(`Setting up subscription for direct endpoint "${endpoint}"`);
  const channel = this.directChannel(context, endpoint);
  
  if (abortController.signal.aborted) {
    context.logger.debug(`Subscription aborted for direct endpoint "${endpoint}"`);
    return;
  }

  // NEW: Wrap handler with validation
  const wrappedHandler = this.createValidatedHandler(handler, endpoint);

  // Set up the subscription
  await channel.subscribe(context, endpoint, wrappedHandler);

  // Set up cleanup on abort
  abortController.signal.addEventListener("abort", async () => {
    await channel.unsubscribe(context, endpoint);
  });
}
```

**Add helper methods:**

```typescript
/**
 * Register route metadata in context store for AI discovery
 */
private registerRoute(context: CraftContext, endpoint: string): void {
  let registry = context.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
  
  if (!registry) {
    registry = new Map<string, DirectRouteMetadata>();
    context.setStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY, registry);
  }
  
  registry.set(endpoint, {
    endpoint,
    description: this.options.description,
    schema: this.options.schema,
    keywords: this.options.keywords,
  });
  
  context.logger.debug(
    `Registered direct route "${endpoint}" in AI-discoverable registry`
  );
}

/**
 * Create a handler that validates body and headers before calling actual handler
 */
private createValidatedHandler(
  handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
  endpoint: string
): (exchange: Exchange<T>) => Promise<Exchange<T>> {
  return async (exchange: Exchange<T>) => {
    // Validate body if schema provided
    if (this.options.schema) {
      let result = this.options.schema["~standard"].validate(exchange.body);
      if (result instanceof Promise) result = await result;

      if (result.issues) {
        const err = rcError("RC5011", result.issues, {
          message: `Body validation failed for direct route "${endpoint}"`,
        });
        exchange.logger.error(err, `Validation error on endpoint "${endpoint}"`);
        throw err;
      }
    }

    // Validate headers if headerSchema provided
    if (this.options.headerSchema) {
      for (const [key, schema] of Object.entries(this.options.headerSchema)) {
        let result = schema["~standard"].validate(exchange.headers[key]);
        if (result instanceof Promise) result = await result;

        if (result.issues) {
          const err = rcError("RC5011", result.issues, {
            message: `Header "${key}" validation failed for direct route "${endpoint}"`,
          });
          exchange.logger.error(err, `Header validation error on endpoint "${endpoint}"`);
          throw err;
        }
      }
    }

    // Call original handler
    return handler(exchange.body as T, exchange.headers);
  };
}
```

### 4. Add Error Code

File: `packages/routecraft/src/error.ts`

```typescript
export const RC = {
  // ... existing codes ...
  
  RC5011: {
    message: "Direct route schema validation failed",
    category: "adapter" as const,
    docs: "https://routecraft.dev/docs/reference/errors#RC5011",
  },
} as const;
```

### 5. Update DSL Documentation

File: `packages/routecraft/src/dsl.ts`

```typescript
/**
 * Create a direct adapter for synchronous inter-route communication.
 * 
 * @example
 * // Basic route with schema validation
 * import { z } from 'zod'
 * 
 * craft()
 *   .from(direct('user-processor', {
 *     schema: z.object({
 *       userId: z.string(),
 *       action: z.enum(['create', 'update', 'delete'])
 *     }),
 *     headerSchema: {
 *       'x-tenant-id': z.string().uuid()
 *     }
 *   }))
 *   .process(processUser)
 * 
 * @example
 * // AI-discoverable route (for future AI agent routing)
 * craft()
 *   .from(direct('fetch-content', {
 *     description: 'Fetch and summarize web content from URL',
 *     schema: z.object({ url: z.string().url() }),
 *     keywords: ['fetch', 'web', 'scrape']
 *   }))
 *   .process(fetchAndSummarize)
 * 
 * @example
 * // Dynamic endpoint (destination only)
 * craft()
 *   .from(source)
 *   .to(direct((ex) => `handler-${ex.body.type}`))
 */
export function direct<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: Partial<DirectAdapterOptions>,
): DirectAdapter<T> {
  return new DirectAdapter<T>(endpoint, options);
}
```

## Testing

File: `packages/routecraft/test/direct-validation.test.ts`

**Test cases:**

### Schema Validation Tests

1. ✅ Valid body passes schema validation
2. ✅ Invalid body throws RC5011 with validation details
3. ✅ Missing required field throws RC5011
4. ✅ Nested object validation works
5. ✅ Array validation works

### Header Validation Tests

6. ✅ Valid headers pass headerSchema validation
7. ✅ Invalid header throws RC5011
8. ✅ Missing required header throws RC5011
9. ✅ Multiple header validations work

### Validation Behavior Tests

10. ✅ Validation only occurs on consumer side, not producer
11. ✅ Multiple consumers with different schemas work correctly
12. ✅ Validation works with static endpoint
13. ✅ No validation when schema not provided (backward compatible)

### Registry Tests

14. ✅ Routes with description register in context store
15. ✅ Routes without description not registered
16. ✅ Registry is created if not exists
17. ✅ Multiple routes register correctly
18. ✅ Registry accessible from context store
19. ✅ Registry contains correct metadata

**Example test:**

```typescript
import { expect, test } from "vitest";
import { context, craft, direct, simple } from "@routecraft/routecraft";
import { z } from "zod";

test("direct route validates body with schema", async () => {
  const schema = z.object({
    userId: z.string(),
    action: z.enum(['create', 'update'])
  });
  
  const handler = vi.fn();
  
  const ctx = context()
    .routes([
      craft()
        .id('producer')
        .from(simple({ userId: '123', action: 'create' }))
        .to(direct('endpoint')),
      
      craft()
        .id('consumer')
        .from(direct('endpoint', { schema }))
        .to(handler)
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(handler).toHaveBeenCalledTimes(1);
});

test("direct route throws RC5011 on invalid body", async () => {
  const schema = z.object({
    userId: z.string(),
    action: z.enum(['create', 'update'])
  });
  
  const errorHandler = vi.fn();
  
  const ctx = context()
    .on('error', errorHandler)
    .routes([
      craft()
        .id('producer')
        .from(simple({ userId: 123, action: 'invalid' })) // Invalid
        .to(direct('endpoint')),
      
      craft()
        .id('consumer')
        .from(direct('endpoint', { schema }))
        .to(vi.fn())
    ])
    .build();
  
  await ctx.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  await ctx.stop();
  
  expect(errorHandler).toHaveBeenCalled();
  const error = errorHandler.mock.calls[0][0].details.error;
  expect(error.code).toBe('RC5011');
});

test("routes with description register in store", async () => {
  const ctx = context()
    .routes(
      craft()
        .id('discoverable')
        .from(direct('test-route', {
          description: 'Test route',
          schema: z.object({ test: z.string() }),
          keywords: ['test']
        }))
        .to(vi.fn())
    )
    .build();
  
  await ctx.start();
  
  const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
  expect(registry).toBeDefined();
  expect(registry.has('test-route')).toBe(true);
  
  const metadata = registry.get('test-route');
  expect(metadata.description).toBe('Test route');
  expect(metadata.keywords).toEqual(['test']);
  
  await ctx.stop();
});
```

## Documentation Updates

### File: `apps/routecraft.dev/src/app/docs/reference/adapters/page.md`

Update direct adapter section:

````markdown
### direct

#### Schema Validation (New in v0.3)

Direct routes now support Zod schema validation for type safety:

```ts
import { z } from 'zod'

craft()
  .from(direct('user-processor', {
    schema: z.object({
      userId: z.string().uuid(),
      action: z.enum(['create', 'update', 'delete']),
      data: z.record(z.any()).optional()
    }),
    headerSchema: {
      'x-tenant-id': z.string().uuid(),
      'x-request-id': z.string()
    }
  }))
  .process(processUser)
````

Validation occurs on the **consumer side** when the route receives a message. If validation fails, a `RC5011` error is thrown with details about what failed.

#### AI Discoverability (Experimental)

Routes can optionally include a description to make them discoverable by AI agents (requires `@routecraft/ai` package):

```ts
craft()
  .from(direct('fetch-content', {
    description: 'Fetch and summarize web content from a URL',
    schema: z.object({ url: z.string().url() }),
    keywords: ['fetch', 'web', 'scrape', 'summarize']
  }))
  .process(fetchAndSummarize)
```

Routes with descriptions are automatically registered in the context store and can be discovered by AI routing adapters.

````

## Migration Guide

### No Breaking Changes

All new fields are optional - existing code continues to work without modification.

### Adding Validation to Existing Routes

```typescript
// Before
craft()
  .from(direct('process-order'))
  .process(processOrder)

// After - with validation
craft()
  .from(direct('process-order', {
    schema: z.object({
      orderId: z.string(),
      items: z.array(z.object({
        productId: z.string(),
        quantity: z.number().positive()
      }))
    })
  }))
  .process(processOrder)
````

### Preparing for AI Routing

```typescript
// Add description to make route AI-discoverable
craft()
  .from(direct('process-order', {
    description: 'Process and validate customer order',
    schema: z.object({ /* ... */ }),
    keywords: ['order', 'purchase', 'checkout']
  }))
  .process(processOrder)
```

## Success Criteria

- ✅ All new fields added to DirectAdapterOptions
- ✅ Validation logic implemented and working
- ✅ Registry stores metadata correctly
- ✅ RC5011 error code added
- ✅ All tests passing (20+ test cases)
- ✅ Documentation updated
- ✅ No breaking changes
- ✅ Backward compatible with existing routes

## Estimate

**Total: 4-5 hours**

- Implementation: 2-3 hours
- Testing: 1-2 hours
- Documentation: 1 hour