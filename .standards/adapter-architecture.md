# Adapter Architecture

Patterns, file structure, authoring guide, and anti-patterns for Routecraft adapters. This document is the single authority for how adapters are structured internally.

For user-facing adapter documentation, see the [adapters reference](https://routecraft.dev/docs/reference/adapters) and [custom adapters guide](https://routecraft.dev/docs/advanced/custom-adapters).

---

## Adapter Roles

Every adapter is built from up to four role slots. Each slot carries exactly one contract; a slot is never overloaded with a second meaning (issue #532 is the design record):

```ts
interface Source<T>      { subscribe(sub): Promise<void> } // stream IN: 0..N exchanges, batch/lifecycle semantics
interface Destination<T> { send(exchange, ctx?): void }    // push OUT: per exchange, body unchanged, ALWAYS void
interface Enricher<T, R> { fetch(exchange, ctx?): R }      // pull IN:  per exchange, produces a value
interface Transformer    { transform(body): R }            // pure body mapping
```

The operation keyword resolves the role; no keyword was added or renamed for this model:

| keyword | resolves to | body afterwards |
|---|---|---|
| `.from(x)` | `subscribe` | what the source emits |
| `.to(x)` / `.tap(x)` | `send` if present, else `fetch` | send: unchanged; fetch: replaced by result (tap always discards) |
| `.enrich(x, agg?)` | `fetch` | aggregator merges; aggregator omitted = replace |
| `.transform(x)` / `.process(x)` | transformer | body-in-body-out vs exchange-in-exchange-out |

Precedence, one line: when an adapter has both `send` and `fetch`, `.to()` picks `send` ("to a file means save to it"). Fetch-only adapters in `.to()` replace the body (this is what keeps `.to(http({ url }))` and `.to(direct("x"))` working). Function forms route by their inferred return type: `.to((ex) => void)` is a send, `.to((ex) => R)` replaces the body with `R`.

`send` is strictly void. A send that produces a receipt (a message id, an etag, a created-resource URL) surfaces it via the `SendContext` header sink (`ctx?.setHeader(key, value)`); the `.to()` step merges the collected headers onto the continuing exchange. Receipts reuse the adapter's read-side header keys ONLY when the written and read resource are the same entity: carddav writes set the same `routecraft.carddav.url` / `.uid` / `.etag` keys the read side sets (plus `.created`), because a saved card IS the card that was read. When they are different entities the receipt gets its own key: an outbound mail is not the inbound message, so the send sets `routecraft.mail.sentMessageId` (plus `.accepted` / `.rejected` / `.response`) and never clobbers the source's `routecraft.mail.messageId`.

## The Option Laws

1. **Bare factory, one honest type, all its roles present; POSITION selects the role.** `.from(file({ path }))` reads, `.to(file({ path }))` writes, `.enrich(file({ path }))` reads mid-route. No `mode` options.
2. **Options never change the adapter's type**, with ONE sanctioned exception: `chunked: true` may change the Source item type (whole vs per-item). Exactly two overloads (literal `true` / absent-or-`false`); NO widened-boolean overload, so `chunked: someBool` is a compile error and dynamic chunking is an explicit branch at the call site. Destination/Enricher roles are identical under chunked.
3. **Same type, different behavior = discriminated OPTIONS, never verbs**: `append: true`, `delete: true` (mutually exclusive, guarded with `RC5003` at construction), mail's `action` union (per-action required fields intact), carddav's `action`.
4. **Key-presence overloads are permitted** (`http({ url })` client vs `http({ path })` server; `mail()` send vs `mail({ action })` operation vs `mail({ folder })` fetch) because the operation keyword is the category enforcer: `.from(http({ url }))` fails to compile because that shape has no `subscribe`. Key presence has no widening hazard (unlike boolean literals). Key-sniffing over OPTIONAL keys remains forbidden (see naming-policy.md).
5. **True sends that produce receipts surface them via HEADERS**, never as a body replacement (see the `SendContext` sink above).
6. **No new DSL keywords. No nested verb imports. No dot-notation factories.** The transformer family stays on the bare factory, discriminated by key presence (`path` present = file roles; absent = transformer) and enforced by `.transform()` requiring a `transform` slot. `path` always means a file path; a transformer's extraction key uses a different name (json's `pointer`), so the two option shapes never collide.

What these laws forbid (all removed in the #532 refactor, do not reintroduce): `mode` options that change the adapter's kind, path-string sniffing, category inference from option VALUES, result-returning `send`, `Omit<Options, "path">` overload idioms, and per-mode type aliases (`FileReadAdapter` and friends).

---

## Single-Factory Pattern

Each adapter concept (direct, http, simple, etc.) exposes **one factory function** that returns the appropriate interface based on parameters; users think in concepts, not operations (source, destination). This is the cornerstone of DX. The pattern is documented user-facing in the custom-adapters guide (`apps/routecraft.dev/src/app/docs/advanced/custom-adapters/page.md`): one factory per concept with overloads and structural discrimination ("Factory function" section), `{Concept}{Operation}Adapter` class naming even for single-role adapters (same section), and the per-concept directory layout with one file per role ("File structure" section). Follow that guide for new adapters; the rule below is internal-only and has no docs equivalent.

### Factories return interfaces, not classes

Factory return types must be interface types (`Source<T>`, `Destination<T>`, `Enricher<T, R>`, intersections of them), never class types.

```typescript
// Good: returns interface type
export function http<T, R>(options: HttpClientOptions<T>): Enricher<T, HttpResult<R>> {
  return new HttpEnricherAdapter<T, R>(options);
}

// Bad: returns class type (exposes implementation)
export function http<T, R>(options: HttpClientOptions<T>): HttpEnricherAdapter<T, R> { ... }
```

The runtime object must agree with the declared type: expose only the slots the declared type carries (a read-shaped `carddav()` has no `send` on the returned object, so `.to(carddav())` resolves to fetch as the type promises). When a facade class implements several roles, the factory assembles a slot object rather than returning the class instance with extra slots attached.

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
- Implement only the role slot(s) you need: `Source.subscribe`, `Destination.send`, `Enricher.fetch`, `Processor.process`, `Transformer.transform`.
- `Destination<T>` pushes out and is strictly void (`.to()`, `.tap()`); `Enricher<T, R>` pulls in and produces a value (`.enrich()`, and the fetch fallback in `.to()` / `.tap()`). An adapter may carry both slots on one object; `.to()` prefers `send`.
- Use `CraftContext` stores for shared state; merge options via `MergedOptions` when relevant.
- Prefer pure functions for transform-like behavior; keep side effects in `.to(...)` destinations.

### Identification and logging

- Provide a stable `adapterId` string (e.g., `"routecraft.adapter.my-adapter"`).
- Use `context.logger` in sources and `exchange.logger` in processors/destinations.
- Prefer structured logs with a descriptive message and metadata object.

### Options and configuration

- Use a single constructor with a minimal options object: `myAdapter(options?: Partial<MyOptions>)`.
- For adapters needing context-level config, implement `MergedOptions<T>`: expose `options` and a `mergedOptions(context)` method that reads from a typed `StoreRegistry` key. The full walkthrough (companion plugin, precedence, rationale) is documented at `apps/routecraft.dev/src/app/docs/advanced/merged-options/page.md`.
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

For naming conventions (Source/Destination vs Server/Client), see [naming-policy.md](./naming-policy.md). The public type shape -- optional `XxxBaseOptions`, `XxxServerOptions` / `XxxClientOptions`, and the exported `XxxOptions` union used as the factory parameter type -- is documented in the custom-adapters guide (`apps/routecraft.dev/src/app/docs/advanced/custom-adapters/page.md`, "Options naming" section). One internal type has no docs equivalent: declare a non-exported intersection `type XxxOptionsMerged = XxxServerOptions & XxxClientOptions` and use it for `this.options`, the `StoreRegistry` entry, and the `mergedOptions()` return type.

### Source adapters

- Signature: `subscribe(sub: Subscription<T>)` returning a Promise that resolves when the source completes or is aborted. The `Subscription` object carries everything the engine provides: `{ context, signal, meta, ready(), complete(reason?), emit(msg) }`. New capabilities arrive as new fields, never as new parameters.
- Emit messages with `await sub.emit({ message, headers? })` and ignore the resolved exchange. When the raw payload needs parsing (json, csv, jsonl, html), attach a deferred parser with `{ message: raw, parse, parseFailureMode }` so malformed payloads surface as per-exchange parse failures (RC5016) instead of killing the source; sources that emit ready-to-use bodies (http, timer, cron) emit without `parse`.
- Call `sub.ready()` once the source is wired and able to produce (routes emit `route:started` after every source is ready).
- Respect `sub.signal.aborted`; add an abort listener to clean up subscriptions. Finite sources call `sub.complete()` when done producing.
- For indefinite sources, resolve the returned Promise only on abort/unsubscribe.
- `.from()` also accepts (async) generator functions and bare (async) iterables of bodies; the builder normalizes them via `toSource()` in `operations/from.ts`. Prefer a class adapter once options or registries are involved.

### Destination adapters

- Signature: `send(exchange, ctx?): Promise<void>`. Strictly void: the body flows through a `.to()` step unchanged.
- Surface receipts (message ids, etags, created-resource URLs) via `ctx?.setHeader(key, value)` (the `SendContext` sink); the `.to()` step merges them onto the continuing exchange. Reuse the adapter's header namespace.
- Works with `.to()` and `.tap()` (`.tap()` receives a snapshot and runs fire-and-forget; its receipt headers are discarded with the snapshot).
- Pull context from `DefaultExchange.context` if needed for stores or loggers.

### Enricher adapters

- Signature: `fetch(exchange, ctx?): Promise<R>` where R is the produced value (an HTTP result, parsed file content, fetched messages).
- Works with `.enrich()` (aggregator merges; aggregator omitted = the value replaces the body), `.to()` (fetch-only fallback: the value replaces the body), and `.tap()` (fetch and discard).
- `ctx` is the abort surface ({@link StepSignalContext}); forward `ctx?.signal` into cancellation-aware IO.

### Processor/Transformer adapters

- **Processor:** `process(exchange) => Exchange` -- can change headers, body, or logger.
- **Transformer:** `transform(body) => newBody` -- pure, body-only change; framework writes back to exchange body.
- Keep these pure where possible; avoid external effects -- use `.to(...)` instead.

**Which to implement when:**

- `Transformer` for reusable, pure body mapping with options.
- `Processor` only when you need headers, exchange replacement, or reusable read-IO with standard behavior.
- `Destination<T>` when the adapter pushes the exchange OUT (side effects: writes, sends, deletes).
- `Enricher<T, R>` when the adapter pulls a value IN (reads, lookups, calls that produce data).
- Both slots on one object when the concept genuinely has both directions (file: send writes, fetch reads).

### Callable variants

Callable variants allow bare functions as adapters -- critical for tests, prototypes, and simple cases:

```typescript
// Test: inline mock destination
route.from(simple(() => ({ id: 1 }))).to(mock());

// Production: full adapter
route.from(direct()).to(http({ url: 'https://api.example.com' }));
```

The builder wraps bare functions automatically:

```typescript
from<T>(source: SourceLike<T>): RouteBuilder<T> {
  // SourceLike = Source | CallableSource | GeneratorSource | (Async)Iterable;
  // toSource() normalizes all of them into a Source.
  return new RouteBuilder(toSource(source));
}
```

### Error handling

- Catch and log external I/O failures with `context.logger.error(error, message)` or `exchange.logger.error(...)`.
- Abort only the route you own by calling `sub.complete(reason)` inside sources when unrecoverable.

---

## Skeletons

### Source adapter

```ts
import type { Source, Subscription } from "@routecraft/routecraft";

export interface MySourceOptions {
  pollIntervalMs?: number;
}

export class MySourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.my-source";
  constructor(private options: Partial<MySourceOptions> = {}) {}

  async subscribe(sub: Subscription<T>): Promise<void> {
    const { pollIntervalMs = 1000 } = this.options;
    sub.context.logger.info("Starting my-source subscription");
    sub.ready();

    return new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        resolve();
        return;
      }
      const tick = async () => {
        if (sub.signal.aborted) {
          resolve();
          return;
        }
        try {
          const data = undefined as unknown as T; // produce or fetch your message
          await sub.emit({ message: data });
        } catch (error) {
          sub.context.logger.error(error, "my-source handler failed");
          sub.complete(error);
          resolve();
          return;
        }
        setTimeout(tick, pollIntervalMs);
      };

      sub.signal.addEventListener("abort", () => {
        sub.context.logger.debug("my-source aborted");
        resolve();
      });

      tick();
    });
  }
}
```

### Destination adapter (push out, void)

```ts
import {
  type Destination,
  type Exchange,
  type SendContext,
} from "@routecraft/routecraft";

export interface MyDestinationOptions {
  url: string;
}

export class MyDestinationAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = "routecraft.adapter.my-destination";
  constructor(private options: MyDestinationOptions) {}

  async send(exchange: Exchange<T>, ctx?: SendContext): Promise<void> {
    const { url } = this.options;
    exchange.logger.info("Sending message", { url });
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(exchange.body),
    });
    // Receipts ride headers, never the body.
    ctx?.setHeader("routecraft.my-destination.requestId",
      response.headers.get("x-request-id"));
  }
}
```

### Enricher adapter (pull in, produces a value)

```ts
import { type Enricher, type Exchange } from "@routecraft/routecraft";

export interface MyApiOptions {
  endpoint: string;
}

export interface ApiResult {
  id: string;
  status: number;
}

export class MyApiEnricherAdapter<T = unknown> implements Enricher<
  T,
  ApiResult
> {
  readonly adapterId = "routecraft.adapter.my-api";
  constructor(private options: MyApiOptions) {}

  async fetch(exchange: Exchange<T>): Promise<ApiResult> {
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

`Exchange<T>` is immutable: every field is `readonly` and the wrapper, headers, and principal are shallow-frozen at construction. Processors must build a new exchange and return it; mutating the parameter fails at compile time and again at runtime as a `TypeError`. The framework re-wraps the returned plain object back into a `DefaultExchange` so context binding and route internals survive the spread.

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

To change multiple fields, batch them in one spread (one wrapper + one headers/body allocation regardless of how many fields change):

```ts
return {
  ...exchange,
  body: nextBody,
  headers: { ...exchange.headers, "x-stage": "processed" },
};
```

Avoid chained per-field updates; each chained call allocates an extra wrapper. See `.standards/type-safety-and-schemas.md` (Exchange Immutability) for the full contract.

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

## Factory Tagging for Testability

Every adapter factory stamps its return value with `tagAdapter(instance, factory, factoryArgs(...))` so the testing package's `mockAdapter(factory, ...)` can match instances back to their factory at route execution time. Always build the args tuple with `factoryArgs(...)` (it trims trailing `undefined` so `args.length` matches what the user typed), pass the factory function itself as the second argument (identity is what `mockAdapter` matches on), and tag at every return path of a multi-interface factory. The full contract with examples is documented in the custom-adapters guide (`apps/routecraft.dev/src/app/docs/advanced/custom-adapters/page.md`, "Making your adapter mockable" section).

One consequence with no docs equivalent: because `tagAdapter` stamps **non-enumerable symbol properties** (documented in the custom-adapters guide's "Making your adapter mockable" section), wrappers created via object spread lose them. When an adapter instance must be cloned, use `Object.create(Object.getPrototypeOf(adapter))` plus `Object.assign` plus re-`tagAdapter`.

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
- [ ] **Does not mutate the exchange.** Processor / Destination / aggregator implementations build a derived exchange via spread (`{ ...exchange, body: x }`) or `DefaultExchange.rewrap`; direct assignment to `exchange.body`, `exchange.headers[...]`, or `exchange.principal` is absent. Drop signalling uses `markDropped(exchange)`, not a header flag.
- [ ] JSDoc documentation added
- [ ] Tests written and passing
- [ ] Exported from package index
- [ ] Callable variant supported (functions accepted as adapters)
- [ ] Factory tagged via `tagAdapter(instance, factory, factoryArgs(...))` at every return path (see "Factory Tagging for Testability")

---

## References

- Adapter source: `packages/routecraft/src/adapters/`
- AI adapter source: `packages/ai/src/`
- Testing adapters: `packages/testing/src/adapters/`
- Public docs: `apps/routecraft.dev/src/app/docs/reference/adapters/page.md`
- Custom adapters guide: `apps/routecraft.dev/src/app/docs/advanced/custom-adapters/page.md`
