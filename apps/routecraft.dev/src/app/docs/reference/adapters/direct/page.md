---
title: direct
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
// Source (endpoint = route id). Body types are unknown at the adapter
// layer; schemas live on the route builder via `.input()` / `.output()`.
direct(options?: Partial<DirectServerOptions>): Source<unknown>

// Destination (registry-aware: body type resolves from DirectEndpointRegistry when populated)
direct<K extends RegisteredDirectEndpoint>(endpoint: K): Destination<ResolveBody<DirectEndpointRegistry, K>, unknown>

// Destination (names a target route)
direct<T>(endpoint: string | ((exchange: Exchange<T>) => string)): Destination<T, T>

// Destination with explicit input != output (e.g. in-process agent call)
direct<TIn, TOut>(
  endpoint: RegisteredDirectEndpoint | ((exchange: Exchange<TIn>) => string),
): Destination<TIn, TOut>
```

See [Type Safety: Registries](https://github.com/routecraftjs/routecraft/blob/main/.standards/type-safety-registries.md) for how to populate `DirectEndpointRegistry`.

Enable synchronous inter-route communication. Perfect for composable route architectures where you need request-response patterns. The source form uses the route's `.id()` as the endpoint name; destinations address the target by id.

Discovery metadata (`.title()`, `.description()`) and schemas (`.input()`, `.output()`) live on the route builder, not the adapter. The framework validates `.input()` before the pipeline runs and `.output()` before the primary destination fires -- any source adapter (direct, mcp, future ones) inherits this validation automatically.

```ts
// Producer route that sends to a direct endpoint
craft()
  .id('data-producer')
  .from(source)
  .transform(processData)
  .to(direct('processed-data'))

// Consumer route that receives from the endpoint (route id = endpoint)
craft()
  .id('processed-data')
  .from(direct())
  .process(businessLogic)
  .to(destination)

// Consumer with framework-enforced validation
craft()
  .id('order-processing')
  .description('Validate and persist an incoming order')
  .input({ body: z.object({ orderId: z.string() }) })
  .output({ body: z.object({ status: z.literal('created'), orderId: z.string() }) })
  .from(direct())
  .process(validateOrder)
  .process(saveOrder)
  .transform(() => ({ status: 'created', orderId: '12345' }))

// Dynamic endpoint based on message content (destination side)
craft()
  .id('dynamic-router')
  .from(source)
  .to(direct((ex) => `handler-${ex.body.type}`))

// Route messages to different handlers based on priority
craft()
  .id('priority-router')
  .from(source)
  .to(direct((ex) => {
    const priority = ex.headers['priority'] || 'normal';
    return `processing-${priority}`;
  }))

// Consumer routes -- their ids match the dynamic target names
craft()
  .id('processing-high')
  .from(direct())
  .to(urgentProcessor)

craft()
  .id('processing-normal')
  .from(direct())
  .to(standardProcessor)

// Agent-only capability -- no .id() means a UUID endpoint,
// discoverable by agents but not callable from code
craft()
  .description('Internal knowledge base lookup')
  .input({ body: z.object({ query: z.string() }) })
  .from(direct())
  .process(fetchSnippets)

// Destination where the callee returns a different body shape than the caller sends.
// Supply two type arguments to express the response shape (e.g. an in-process agent).
craft()
  .id('agent-caller')
  .from(httpSource)
  .transform((body) => ({ name: body.agent, query: body.text }))
  .enrich(direct<{ name: string; query: string }, AgentResult>('agent'))
```

**Source options (adapter-specific only):**
- `channelType` - Custom direct channel implementation (default: in-memory). Per-route override of the context-level default.

Route-level metadata lives on the builder: `.title('...')`, `.description('...')`, `.input({ body, headers })`, `.output({ body, headers })`. `.input()` and `.output()` also accept a bare Standard Schema as a body-only shorthand.

**Key characteristics:**
- **Synchronous**: Calling route waits for response from the consuming route
- **Endpoint = route id**: The direct source uses the route's `.id()` as its endpoint name. Destinations reference the consumer by that id.
- **Agent-only capabilities**: Omit `.id()` to register under a UUID the builder generates; agents can still discover the route via the registry, but it cannot be addressed as a string from code.
- **Framework-enforced validation**: `.input()` and `.output()` schemas are validated by the engine, not the adapter. Validation failure emits `exchange:dropped` (input) or routes to the error handler (output) with `RC5002`.
- **Automatic endpoint name sanitization**: URL-unsafe characters in the route id are URL-encoded for collision-free registry keys.
- **Dynamic destinations**: Destination endpoints can be computed from the exchange; sources always use the route id.

**Perfect for:**
- Breaking large routes into smaller, composable pieces
- HTTP request-response patterns
- Synchronous business logic orchestration
- Testing individual route segments in isolation

**Limitations:**
- **Not compatible with `batch()`**: Because `direct()` is synchronous and blocking, each sender waits for the consumer route to fully process the message before the next message can be sent. This prevents the batch consumer from accumulating multiple messages. If you need to batch messages from multiple sources or split branches, use the `aggregate()` operation instead.

#### Schema Validation

Direct routes support StandardSchema validation for type safety. Behavior depends on your schema library.

**No Schema (Default)**

Without a schema, all data passes through unchanged:

```ts
craft()
  .id('user-processor')
  .from(direct())  // No schema -- all data passes through
  .process(processUser)
```

**Zod 4 Object Types**

Zod 4 uses different object constructors to control extra field handling:

| Constructor | Extra fields | Use case |
|-------------|--------------|----------|
| `z.object()` | Stripped (default) | Strict contracts, clean data |
| `z.looseObject()` | Preserved | Flexible schemas, passthrough |
| `z.strictObject()` | Error (RC5002) | Reject unexpected fields |

```ts
import { z } from 'zod'

// z.object() - strips extra fields (default behavior)
const strictSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update', 'delete'])
})

craft()
  .id('user-processor')
  .input({ body: strictSchema })
  .from(direct())
  .process(processUser)

// Passes: { userId: '...', action: 'create' }
// Passes: { userId: '...', action: 'create', extra: 'field' }
//    Extra fields silently removed from result
// RC5002: { userId: '...', missing: 'action' }
```

```ts
// z.looseObject() - preserves extra fields
const looseSchema = z.looseObject({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update'])
})

craft()
  .id('user-processor')
  .input({ body: looseSchema })
  .from(direct())
  .process(processUser)

// Passes: { userId: '...', action: 'create', extra: 'field' }
//    All fields preserved including extra
```

```ts
// z.strictObject() - rejects extra fields with error
const veryStrictSchema = z.strictObject({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update'])
})

craft()
  .id('user-processor')
  .input({ body: veryStrictSchema })
  .from(direct())
  .process(processUser)

// Passes: { userId: '...', action: 'create' }
// RC5002: { userId: '...', action: 'create', extra: 'field' }
```

**Header Validation**

Without `input.headers`, all headers pass through unchanged. When specified, the same Zod 4 rules apply, with one twist: validated header values are always merged over the original request headers, so caller-supplied pass-through keys survive schemas that would normally strip them.

```ts
// No header schema - all headers pass through unchanged
craft()
  .id('api-handler')
  .input({ body: z.object({ id: z.string() }) })
  // input.headers not specified - all headers preserved
  .from(direct())
  .process(handleRequest)

// z.looseObject() - validate required headers, keep extras
craft()
  .id('api-handler')
  .input({
    headers: z.looseObject({
      'x-tenant-id': z.string().uuid(),
      'x-trace-id': z.string().optional(),
    }),
  })
  .from(direct())
  .process(handleRequest)

// Passes: { 'x-tenant-id': '...', 'x-other': '...' } (validates x-tenant-id, keeps x-other)

// z.object() - validate declared headers; merge preserves pass-through keys
craft()
  .id('api-handler')
  .input({
    headers: z.object({
      'x-tenant-id': z.string().uuid(),
    }),
  })
  .from(direct())
  .process(handleRequest)

// Passes: { 'x-tenant-id': '...', 'x-other': '...' } (x-other preserved via merge)
```

**Schema Coercion**

Validated values are used (schemas can transform data):

```ts
const schema = z.object({
  userId: z.string(),
  createdAt: z.coerce.date()  // Transforms string to Date
})

craft()
  .id('processor')
  .input({ body: schema })
  .from(direct())
  .process((data) => {
    // data.createdAt is Date, not string
    console.log(data.createdAt.getFullYear())
  })
```

**Validation occurs on consumer side only.** Producers send data unchanged; consumers validate on receive.

#### Route Registry

Each direct route registers in `ADAPTER_DIRECT_REGISTRY` so in-process agents can discover and document the routes available in the current context:

```ts
import { ADAPTER_DIRECT_REGISTRY } from '@routecraft/routecraft'

craft()
  .id('fetch-content')
  .title('Fetch content')
  .description('Fetch and summarize web content from URL')
  .input({ body: z.object({ url: z.string().url() }) })
  .output({ body: z.object({ summary: z.string() }) })
  .from(direct())
  .process(fetchAndSummarize)

// Later, query registered routes from context
const ctx = await new ContextBuilder().routes(...).build()
await ctx.start()

const registry = ctx.getStore(ADAPTER_DIRECT_REGISTRY)
const routes = registry ? Array.from(registry.values()) : []
// [{ endpoint, title?, description?, input?, output? }]
```

The direct registry stores only the direct adapter's own metadata. Other adapters that expose routes externally (such as [`mcp()`](/docs/reference/adapters/mcp) or a future inbound `http()`) maintain their own parallel registries; they are never written to or read from the direct registry.
