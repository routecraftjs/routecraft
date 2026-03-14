# Adapter Architecture

Patterns, file structure, authoring guide, and anti-patterns for RouteCraft adapters. This document is the single authority for how adapters are structured internally.

For user-facing adapter documentation, see the [adapters reference](https://routecraft.dev/docs/reference/adapters) and [custom adapters guide](https://routecraft.dev/docs/advanced/custom-adapters).

---

## Single-Factory Pattern

Each adapter concept (direct, http, simple, etc.) exposes **one factory function** that returns the appropriate interface based on parameters.

```typescript
// One concept = one import
import { direct } from '@routecraft/routecraft';

route.from(direct('channel', options)).to(direct(handler));

// NOT multiple imports per concept
import { directSource, directDestination } from '@routecraft/routecraft';
```

Users think in concepts (direct, http, simple), not operations (source, destination). This is the cornerstone of DX.

---

## The 5 Pattern Rules

### Rule 1: One Concept = One Factory

Expose exactly one factory function per adapter concept. Use overloads for multi-interface adapters.

```typescript
// Good: single factory with overloads
export function direct<S>(endpoint: string, options: {...}): Source<...>;
export function direct<T>(endpoint: string | function): Destination<T, T>;

// Bad: multiple factories for one concept
export function directSource(...): Source<...>;
export function directDestination(...): Destination<...>;
```

### Rule 2: Always Use Directory Structure

Use separate files for each operation, even for single-interface adapters.

```
adapters/
  simple/
    source.ts       # SimpleSourceAdapter class
    index.ts        # Public simple() factory + exports

  direct/
    source.ts       # DirectSourceAdapter class
    destination.ts  # DirectDestinationAdapter class
    shared.ts       # Shared helpers (getDirectChannel, etc.)
    types.ts        # Type definitions
    index.ts        # Public direct() factory + exports
```

Every adapter follows the same pattern, making the codebase predictable and easy to extend. If we later need `SimpleDestinationAdapter`, we just add `destination.ts`.

### Rule 3: Factories Return Interfaces, Not Classes

Factory return types must be interface types (`Source<T>`, `Destination<T, R>`), never class types.

```typescript
// Good: returns interface type
export function http<T, R>(options: HttpOptions): Destination<T, HttpResult<R>> {
  return new HttpDestinationAdapter<T, R>(options);
}

// Bad: returns class type (exposes implementation)
export function http<T, R>(options: HttpOptions): HttpDestinationAdapter<T, R> { ... }
```

### Rule 4: Use Structural Type Guards

Use structural checks (`arguments.length`, `typeof`) to discriminate factory overloads.

```typescript
// Good: structural checks
export function direct<...>(...): Source<...> | Destination<...> {
  if (arguments.length === 2) {
    return new DirectSourceAdapter(endpoint, options);
  }
  if (typeof endpoint === 'function') {
    return new DirectDestinationAdapter<T>(endpoint);
  }
  throw new Error('Invalid arguments');
}

// Bad: value-based checks (unreliable)
if (options !== undefined) { ... }
```

### Rule 5: Always Use Multi-Interface Naming

Include the operation in class names, even for single-interface adapters.

```typescript
// Good: operation in name (future-proof)
export class SimpleSourceAdapter<T> implements Source<T> { }
export class HttpDestinationAdapter<T, R> implements Destination<T, HttpResult<R>> { }

// Bad: generic names
export class SimpleAdapter<T> implements Source<T> { }
```

**Class naming pattern:** `{Concept}{Operation}Adapter` (e.g., `DirectSourceAdapter`, `LogDestinationAdapter`, `TimerSourceAdapter`).

---

## Facade Pattern

### Two-role adapters (e.g., MCP, direct)

- **One facade only:** Export a single adapter class (e.g., `McpAdapter`, `DirectAdapter`). It is the only adapter type in the public API for that capability.
- **Internal server/client:** Internal classes that implement the real logic (e.g., `McpServer`, `McpClient`) must **not** be exported and do **not** use the `*Adapter` suffix.
- **Facade is thin:** The main adapter delegates to the internal server/client. The DSL factory decides which role is requested and returns the main adapter configured accordingly.
- **Adapter owns complexity:** Option validation, merging, and non-trivial logic live in the adapter (and its internals). The DSL factory stays as simple as possible: overload resolution and construction only.

### Single-role adapters (e.g., agent, LLM)

- **Exported:** One main adapter; name includes `Adapter` (e.g., `AgentAdapter`, `LlmAdapter`).
- **Factory:** As simple as possible -- construction only; no validation or option logic.
- **Adapter:** Owns option validation, merging, and delegation to internal helpers (e.g., `AgentRunner`, not exported).

### Summary

| What | Rule |
|------|------|
| Exported | One main adapter per capability (name includes `Adapter`) |
| Internal | Server/client or runner classes; no `*Adapter` suffix |
| Factory | Overload resolution and construction only |
| Adapter | Owns option validation, merging, and delegation |

---

## Adapter Authoring Guide

### Goals

- Keep adapters minimal, focused, and composable.
- Implement only the operation interface(s) you need: `Source.subscribe`, `Destination.send`, `Processor.process`, `Transformer.transform`.
- Use `Destination<T, R>` for `.to()`, `.enrich()`, and `.tap()`. Return the result from `send()` -- it will be ignored by `.to()` (default), merged by `.enrich()`, or ignored by `.tap()`.
- Use `CraftContext` stores for shared state; merge options via `MergedOptions` when relevant.
- Prefer pure functions for transform-like behavior; keep side effects in `.to(...)` destinations.

### Identification and logging

- Provide a stable `adapterId` string (e.g., `"routecraft.adapter.my-adapter"`).
- Use `context.logger` in sources and `exchange.logger` in processors/destinations.
- Prefer structured logs with a descriptive message and metadata object.

### Options and configuration

- Use a single constructor with a minimal options object: `myAdapter(options?: Partial<MyOptions>)`.
- For adapters needing context-level config, implement `MergedOptions<T>`: expose `options` and a `mergedOptions(context)` method that reads from a typed `StoreRegistry` key.
- Extend `StoreRegistry` via declaration merging to type your store keys.

### Store keys: use `Symbol.for`

Use `Symbol.for(...)` so the same key is shared across all copies of your package in a process (e.g., CLI `craft run` vs the version the route imports). Export the Symbol and use it in your `declare module` augmentation and in `getStore()`/`setStore()` calls. Do **not** use a local `Symbol("...")` -- that would create different keys per package/version and break lookups.

```ts
export const EXAMPLE_STORE_KEY = Symbol.for("routecraft.adapter.example.store");
export const EXAMPLE_OPTIONS_KEY = Symbol.for("routecraft.adapter.example.options");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [EXAMPLE_STORE_KEY]: Map<string, unknown>;
    [EXAMPLE_OPTIONS_KEY]: Partial<ExampleOptions>;
  }
}
```

### Options naming for two-role adapters

For naming conventions (Source/Destination vs Server/Client), see [naming-policy.md](./naming-policy.md).

When an adapter can be used as both a source and a destination with different options for each role:

**Exported types (public API):**

- **Base:** `XxxBaseOptions` -- shared by both roles.
- **Server:** `XxxServerOptions extends XxxBaseOptions` -- options for `.from()`.
- **Client:** `XxxClientOptions` -- options for `.to()` / `.tap()`.
- **Union:** `XxxOptions = XxxServerOptions | XxxClientOptions` -- constructor parameter type and public signatures.

**Internal type (not exported):**

- **Merged:** `XxxOptionsMerged = XxxServerOptions & XxxClientOptions` -- intersection type for `this.options`, `StoreRegistry`, and `mergedOptions()` return type.

```ts
export interface MyAdapterBaseOptions {
  timeout?: number;
}

export interface MyAdapterServerOptions extends MyAdapterBaseOptions {
  pollInterval?: number;
  schema?: StandardSchemaV1;
}

export type MyAdapterClientOptions = MyAdapterBaseOptions;

// Public: union for constructor
export type MyAdapterOptions = MyAdapterServerOptions | MyAdapterClientOptions;

// Internal: intersection for stored options (not exported)
type MyAdapterOptionsMerged = MyAdapterServerOptions & MyAdapterClientOptions;
```

### Source adapters

- Signature: `subscribe(context, handler, abortController, onReady?)` returning a Promise that resolves when the source completes or is aborted.
- The `handler` has type `(message: T, headers?: ExchangeHeaders) => Promise<Exchange>`. Call `await handler(message, headers)` and ignore the return value.
- Respect `abortController.signal.aborted`; add an abort listener to clean up subscriptions.
- For indefinite sources, resolve the returned Promise only on abort/unsubscribe.

### Destination adapters

- Signature: `send(exchange): Promise<R>` where R is the result type (use `void` if no result).
- Return meaningful data when possible (e.g., database IDs, HTTP status, API responses).
- The same adapter works with `.to()`, `.enrich()`, and `.tap()`:
  - `.to()` ignores the result by default (side-effect only) or replaces body if a value is returned
  - `.enrich()` merges the result into the body by default
  - `.tap()` receives a snapshot and runs fire-and-forget (result ignored)
- Pull context from `DefaultExchange.context` if needed for stores or loggers.

### Processor/Transformer adapters

- **Processor:** `process(exchange) => Exchange` -- can change headers, body, or logger.
- **Transformer:** `transform(body) => newBody` -- pure, body-only change; framework writes back to exchange body.
- Keep these pure where possible; avoid external effects -- use `.to(...)` instead.

**Which to implement when:**

- `Transformer` for reusable, pure body mapping with options.
- `Processor` only when you need headers, exchange replacement, or reusable read-IO with standard behavior.
- `Destination<T, R>` when the adapter produces data for side-effects (`.to()`), enrichment (`.enrich()`), or fire-and-forget (`.tap()`).

### Callable variants

Callable variants allow bare functions as adapters -- critical for tests, prototypes, and simple cases:

```typescript
// Test: inline mock destination
route.from(simple(() => ({ id: 1 }))).to(vi.fn());

// Production: full adapter
route.from(direct('channel', options)).to(http({ url: 'https://api.example.com' }));
```

The builder wraps bare functions automatically:

```typescript
from<T>(source: Source<T> | CallableSource<T>): RouteBuilder<T> {
  const adapter = typeof source === 'function'
    ? { subscribe: source }
    : source;
  return new RouteBuilder(adapter);
}
```

### Error handling

- Catch and log external I/O failures with `context.logger.error(error, message)` or `exchange.logger.error(...)`.
- Abort only the route you own by calling `abortController.abort()` inside sources when unrecoverable.

---

## Skeletons

### Source adapter

```ts
import {
  type Source,
  type Exchange,
  type ExchangeHeaders,
  CraftContext,
} from "@routecraft/routecraft";

export interface MySourceOptions {
  pollIntervalMs?: number;
}

export class MySourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.my-source";
  constructor(private options: Partial<MySourceOptions> = {}) {}

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const { pollIntervalMs = 1000 } = this.options;
    context.logger.info("Starting my-source subscription");

    return new Promise<void>((resolve) => {
      const tick = async () => {
        if (abortController.signal.aborted) return;
        try {
          const data = undefined as unknown as T; // produce or fetch your message
          await handler(data);
        } catch (error) {
          context.logger.error(error, "my-source handler failed");
          abortController.abort();
          resolve();
          return;
        }
        setTimeout(tick, pollIntervalMs);
      };

      abortController.signal.addEventListener("abort", () => {
        context.logger.debug("my-source aborted");
        resolve();
      });

      tick();
    });
  }
}
```

### Destination adapter (void)

```ts
import { type Destination, type Exchange } from "@routecraft/routecraft";

export interface MyDestinationOptions {
  url: string;
}

export class MyDestinationAdapter<T = unknown> implements Destination<T, void> {
  readonly adapterId = "routecraft.adapter.my-destination";
  constructor(private options: MyDestinationOptions) {}

  async send(exchange: Exchange<T>): Promise<void> {
    const { url } = this.options;
    exchange.logger.info("Sending message", { url });
    // perform side-effect using exchange.body / headers
  }
}
```

### Destination adapter (with return value)

```ts
import { type Destination, type Exchange } from "@routecraft/routecraft";

export interface MyApiOptions {
  endpoint: string;
}

export interface ApiResult {
  id: string;
  status: number;
}

export class MyApiAdapter<T = unknown> implements Destination<T, ApiResult> {
  readonly adapterId = "routecraft.adapter.my-api";
  constructor(private options: MyApiOptions) {}

  async send(exchange: Exchange<T>): Promise<ApiResult> {
    const { endpoint } = this.options;
    exchange.logger.info("Calling API", { endpoint });

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(exchange.body)
    });

    return {
      id: response.headers.get('x-request-id'),
      status: response.status
    };
  }
}
```

### Processor adapter

```ts
import { type Processor, type Exchange } from "@routecraft/routecraft";

export class MyProcessorAdapter<T = unknown, R = T> implements Processor<T, R> {
  readonly adapterId = "routecraft.adapter.my-processor";
  async process(exchange: Exchange<T>): Promise<Exchange<R>> {
    const newBody = exchange.body as unknown as R;
    return { ...exchange, body: newBody };
  }
}
```

### Transformer adapter (pure)

```ts
import { type Transformer } from "@routecraft/routecraft";

export class MyTransformerAdapter<T = unknown, R = T>
  implements Transformer<T, R>
{
  readonly adapterId = "routecraft.adapter.my-transformer";
  async transform(body: T): Promise<R> {
    return body as unknown as R;
  }
}
```

---

## Anti-Patterns

- **Service-specific verbs in the public DSL.** Bad: `api.get("/users").map(...)`. Better: `http({ method: "GET", path: "/users" })`.
- **Overloaded constructors that hide behavior.** Bad: `Api("/users")` implying GET by default. Better: explicit options.
- **Coupled cross-route state via globals.** Bad: `global.currentUser = ...`. Better: exchanges or `CraftContext` stores with typed `StoreRegistry` keys.
- **Steps that both transform and side-effect.** Bad: `.process(ex => { ex.body = doThing(ex.body); sendToKafka(ex); return ex; })`. Better: `.transform(doThing).to(kafkaProducer())`.
- **Hidden implicit sources/destinations.** Bad: `.from(httpServer())` where `httpServer` also writes to a DB. Better: keep sources as sources; push side effects into `.to(...)`.
- **Public DSL verbs inside adapters.** Service-specific config belongs in adapter options, not chained DSL.
- **Hidden side effects in sources.** Produce messages only; use `.to(...)` for outputs.
- **Mixing responsibilities.** Transforming and sending should be separate steps.

---

## Adapter Checklist

Before submitting a new or modified adapter:

- [ ] Directory structure follows pattern (operation files + index)
- [ ] Class names use `{Concept}{Operation}Adapter` format
- [ ] Factory returns interface type, not class type
- [ ] Structural type guards used for multi-interface factories
- [ ] Shared logic extracted to `shared.ts` if needed
- [ ] Provides `adapterId`
- [ ] Follows single-responsibility
- [ ] Respects `AbortController` in sources
- [ ] Keeps transforms pure; side effects only in destinations
- [ ] Uses typed `StoreRegistry` and `MergedOptions` if reading from context
- [ ] JSDoc documentation added
- [ ] Tests written and passing
- [ ] Exported from package index
- [ ] Callable variant supported (functions accepted as adapters)

---

## References

- Adapter source: `packages/routecraft/src/adapters/`
- AI adapter source: `packages/ai/src/`
- Testing adapters: `packages/testing/src/adapters/`
- Public docs: `apps/routecraft.dev/src/app/docs/reference/adapters/page.md`
- Custom adapters guide: `apps/routecraft.dev/src/app/docs/advanced/custom-adapters/page.md`
