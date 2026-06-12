---
title: Migrating from 0.5.x to 0.6.0
---

What changed between Routecraft 0.5.0 and 0.6.0, and how to update. {% .lead %}

0.6.0 is a large release: a set of surface changes plus the architecture pass before v1. The contracts that freeze at v1 changed shape once, now, so they do not have to change after; the engine rework also brings a significant performance improvement to route and event processing.

Surface changes:

1. **`skills` is replaced by a unified `blocks` record.** Skills, memory, identity, instructions, and any future system-prompt contribution are now one primitive.
2. **Tag selectors on `tools()` are removed.** Programmatic `tools((catalog) => [...])` is the new escape hatch for "give me all read-only tools" style selection.
3. **The `http()` destination option type is renamed.** `HttpOptions<T>` becomes `HttpClientOptions<T>` now that `http()` is a two-sided adapter (the new HTTP source uses `HttpServerOptions`). Type-only change; runtime behaviour and the `http({...})` call sites are unchanged.
4. **The mail source moves the envelope from `body` to `routecraft.mail.*` headers.** `.from(mail(...))` now delivers the message content on `exchange.body` and the envelope (from, subject, recipients, ...) on headers, matching the HTTP source.

Architecture changes:

5. **Event names are a fixed set; identity moved into the payload.** `route:<id>:exchange:failed` becomes `route:exchange:failed` with `routeId` in `details`. Wildcard subscriptions are replaced by exact names, the `"*"` catch-all, and the `forRoute()` filter helper.
6. **Source adapters receive one `Subscription` object.** The positional `subscribe(context, handler, abortController, onReady?, meta?)` signature is gone. `.from()` additionally accepts async generator functions and iterables.
7. **Custom `Step` implementations return a `StepOutcome`.** Steps no longer receive the engine queue; the executor owns scheduling. Per-execution metadata rides the outcome, not the `Step` instance. Custom aggregators return `{ body, headers? }` instead of a fabricated `Exchange`.
8. **`@routecraft/ai` error codes are renamed.** `RC5025`/`RC5026`/`RC5027` become `AI1001`/`AI1002`/`AI1003`; ecosystem packages now register their own namespaced codes via `registerErrorCodes()`.
9. **The builder enforces position in the type system.** `craft()` returns a pre-`from` builder; pipeline operations before `.from()` are now compile errors. Builder generics take a state bag (`RouteBuilder<{ body: T }>`).
10. **Splitters return child bodies.** `.split()` callbacks return values (or `splitChild(body, headers)`) instead of hand-built `Exchange` instances.
11. **Consumers take envelopes and a deps bag.** `Consumer.register` receives the `Message` envelope; consumer classes construct from a single `ConsumerDeps` object.
12. **Header keys are consolidated.** `HeadersKeys` keeps framework keys only; adapter keys move to per-adapter objects (`MailHeaders`, `CronHeaders`, `TimerHeaders`, `FileHeaders`, `CsvHeaders`, `JsonlHeaders`, `CarddavHeaders`). `HEADER_MAIL_*` / `HEADER_CARDDAV_*` constants and `HeaderKeysRegistry` are removed.
13. **`client.send` is now `client.sendDirect`**, and capability discovery is public: `context.capabilities()` replaces reads of the internal direct registry.
14. **Naming sweeps.** `CardDAV*` exports become `Carddav*` (acronym casing, per the `Http` precedent); jsonl's `JsonlSourceOptions` / `JsonlDestinationOptions` / `JsonlCombinedOptions` fold into one `JsonlFileOptions`.

Routes built only from the DSL (`craft().from(...).transform(...).to(...)`) with framework adapters need changes for the agent/tools/mail surface (1-4) where used, event subscriptions (5), builder call order that was already a runtime error (9), and adapter header constants (12). The rest affects adapter authors and advanced integrations.

Two behavioural notes that are not API changes: context store seeding for `cron`/`direct`/`mail` config now happens in `initPlugins()` (called automatically by `start()`) instead of the `CraftContext` constructor, and plugin teardown plus `registerTeardown` callbacks now unwind in reverse (LIFO) order.

---

## 1. Agents: `skills` is replaced by `blocks`

`AgentOptions.skills: string[]` and `agentPlugin({ skills })` are removed. They are replaced by a single primitive that covers what skills used to do and unifies it with memory, identity, instructions, and any other system-context contribution: `AgentOptions.blocks: Blocks` (a `Record<string, BlockBody | false>`).

A block body has:

- `mode`: `"inject"` to always concatenate the resolved content into the system prompt as `## <name>\n\n<content>`, or `"progressive"` to surface the block as a synthetic loader tool the model invokes on demand. Progressive blocks require a `description`.
- `lifetime` (optional, default `"dispatch"`): `"dispatch"` re-runs the resolver on every dispatch; `"context"` runs it once per `CraftContext` and reuses the result.
- `value`: a static string used verbatim, or a function `(exchange, context, events, client) => string | Promise<string>`. The `client` carries `forward(routeId, payload)`, the same callable route `.error()` handlers receive, so a resolver can delegate to a registered direct route. `events` is reserved (always `[]` today) for a forthcoming exchange-event log.

The block's `name` is the record key, not a field on the body. Names starting with the reserved `_block_` prefix are rejected (`AI1002`).

The big semantic shift: progressive disclosure is now the default for skills. The model sees each skill's name and description in the tool list and loads the body via a tool call only when relevant. This matches Claude Code's actual default. To preserve the legacy "always inject every skill" behaviour, opt into `mode: "inject"`.

### 1.1 Inline `skills` becomes inline `blocks`

**Before (0.5.x):**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  skills: ["web-search", "cite-sources"],
});
```

**After (0.6.0):**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: {
    "web-search": {
      mode: "inject",
      value: "Always search before answering.",
    },
    "cite-sources": {
      mode: "inject",
      value: "Always cite your sources.",
    },
  },
});
```

### 1.2 `agentPlugin({ skills })` is removed; `skills()` returns blocks

`agentPlugin({ skills: { ... } })`, the `Skill` / `SkillRegistry` / `RegisteredSkillName` / `SkillOverride` exports, and the `ADAPTER_SKILL_REGISTRY` symbol are all gone. There is no shim.

`skills({ source, mode?, lifetime? })` keeps the same name as the 0.5 markdown loader but now returns a `Blocks` record you spread into an agent's `blocks: { ... }` map. It reads the same markdown layout (flat `<name>.md` and nested `<name>/SKILL.md`, with the Claude Code frontmatter the old loader accepted). **The default `mode` is `"progressive"`** so the model picks which skills to load.

**Before (0.5.x):**

```ts
import { agentPlugin, skills } from "@routecraft/ai";

agentPlugin({
  skills: await skills("./skills"),
});

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  skills: ["web-search"],
});
```

**After (0.6.0), progressive disclosure (recommended):**

```ts
import { agent, skills } from "@routecraft/ai";

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: { ...(await skills({ source: "./skills" })) },
});
```

**After (0.6.0), recovering the legacy "concatenate every skill" behaviour:**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: { ...(await skills({ source: "./skills", mode: "inject" })) },
});
```

The function signature changed from `skills(path)` to `skills({ source })`. The return type changed from `Record<name, Skill>` to `Blocks`. Both are visible at the call site.

Spreading flattens every skill into the top-level namespace. To keep them grouped under one addressable key, assign the result to a nested block instead of spreading it (see [1.2b](#1-2b-grouping-skills-under-one-key)).

### 1.2b Grouping skills under one key

A `blocks` value may be a single `BlockBody` (a leaf) or a nested `Blocks` record (a group). Assigning `skills({ source })` to a key, rather than spreading it, keeps every skill under that namespace instead of dissolving them into the top level:

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: {
    skills: await skills({ source: "./skills" }), // a named group
    tone: { mode: "inject", value: "Be terse." }, // a single block
  },
});
```

Groups flatten depth-first into a single canonical name joined by `__`. A skill `onboarding` under the `skills` group resolves to `skills__onboarding` for its system-prompt heading, its loader tool (`_block_load_skills__onboarding`), and its `AgentResult.blocksLoaded` entry. `__` (not `/`) is used because loader tool names reach the provider unsanitised and must match `^[a-zA-Z0-9_-]{1,64}$`.

Grouping isolates collisions (a skill named `tone` resolves to `skills__tone`, distinct from a top-level `tone` block) and lets you remove or replace the whole collection by its top-level key. Two blocks that flatten to the same name are rejected with `AI1002`. The empty-name and reserved-`_block_`-prefix rules apply at every nesting level. Per-member merge inside a group is not supported in 0.6.0: a per-agent group replaces a default group of the same name wholesale, and `skills: false` removes the whole group.

### 1.3 `agents()` markdown loader: `skills:` frontmatter is rejected

The agent markdown loader (`agents("./agents")`) used to accept a `skills:` frontmatter field. That field is now rejected with `RC5003` "not yet supported" because blocks accept function-form resolvers that YAML cannot express. Set `blocks` on the registered agent in code instead, either via the per-agent `overrides` map handed to `agents()` or via the agent's call site.

**Before (0.5.x):** `agents/researcher.md`

```md
---
name: researcher
description: Researches things
model: anthropic:claude-sonnet-4-6
skills:
  - web-search
  - cite-sources
---
You are a researcher.
```

**After (0.6.0):** drop `skills:` from frontmatter, supply blocks via the overrides map:

```ts
import { agentPlugin, agents, skills } from "@routecraft/ai";

agentPlugin({
  agents: await agents("./agents", {
    researcher: {
      blocks: await skills({ source: "./skills" }),
    },
  }),
});
```

### 1.4 Resolver-backed blocks (memory, tenant config, identity)

Function-form resolvers receive the live exchange, context, a reserved events list, and a block client. Use `client.forward(routeId, payload)` to delegate to a registered direct route. Use `lifetime: "context"` to evaluate once per `CraftContext` and cache the result across dispatches.

This is the pattern memory adapters will use; it is illustrative, not a shipped builder in 0.6.0.

```ts
import { craft, direct } from "@routecraft/routecraft";
import { agent } from "@routecraft/ai";

craft()
  .id("memory:get")
  .from(direct())
  // `.transform(body => body)` is body-in / body-out; the exchange
  // itself is frozen in 0.6 (copy-on-write), so `ex.body = ...` from
  // a `.process()` step would throw. Return the new body instead.
  .transform(async (body) => {
    const { subject } = body as { subject: string };
    return await loadMemoryFor(subject);
  });

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are Zoe.",
  blocks: {
    memory: {
      description: "Long-term notes about the operator.",
      mode: "progressive",
      lifetime: "context",
      value: async (exchange, _context, _events, client) => {
        // Read identity from the typed principal, not from a header.
        // `exchange.principal` is the verified, framework-tracked
        // identity (authenticity, expiry, claims); a string header
        // would bypass those guarantees.
        const subject = exchange.principal?.subject;
        if (!subject) return ""; // anonymous: no memory to inject
        const result = await client.forward("memory:get", { subject });
        return result as string;
      },
    },
  },
});
```

A resolver that needs nothing more than the `CraftContext` can ignore the client and read from the context directly:

```ts
{
  blocks: {
    "tenant-config": {
      mode: "inject",
      lifetime: "context",
      value: (_exchange, context) => {
        const config = context.services.get(TenantConfig);
        return `Tenant: ${config.name}`;
      },
    },
  }
}
```

### 1.5 Loader tool naming reservation

Progressive blocks are exposed to the model as synthetic tools named `_block_load_<blockName>`. Any user tool (fn id, direct route id, or block name) starting with `_block_` is rejected at construction or dispatch time with `AI1002`. Rename the offending tool or block.

### 1.6 `AgentResult`: tool-call partitioning and `blocksLoaded`

Synthetic block-loader invocations no longer appear on `AgentResult.toolCalls`. They surface on a new `AgentResult.blocksLoaded?: AgentBlockLoadSummary[]` so post-dispatch assertions on the agent's user-tool usage stay clean. Each entry carries `blockName`, `toolName` (the `_block_load_<name>` form), `toolCallId`, and either `output` or `error`.

Observability follows the same split: loader calls emit `route:<id>:agent:block:loaded` and `:agent:block:error` instead of the `:agent:tool:*` events.

### 1.7 Defaults merging and removal via `false`

`agentPlugin({ defaultOptions: { blocks } })` lets a context install shared blocks once. The merge rule differs from how `tools` merges: a per-agent `blocks: { ... }` does **not** replace defaults wholesale. Instead, defaults are merged into the final blocks record by name. A per-agent block whose key matches a default replaces only that entry; non-colliding defaults still apply.

To remove a default from a specific agent, set its name to `false`:

```ts
agentPlugin({
  defaultOptions: {
    blocks: {
      "house-style": { mode: "inject", value: "Be terse." },
      safety: { mode: "inject", value: "Refuse harmful requests." },
    },
  },
});

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are a friendly assistant.",
  blocks: {
    // Override "house-style" with a friendlier framing
    "house-style": { mode: "inject", value: "Be warm and helpful." },
    // Drop the "safety" default from this specific agent
    safety: false,
  },
});
```

A `false` for a name absent from defaults is a no-op so adding or removing defaults later cannot silently break an agent's block list.

### 1.8 Multiple `agentPlugin` installs

Two `agentPlugin` installs that each set `defaultOptions.blocks` now merge additively by name (a name set in both installs throws `RC5003`). This matches the per-agent merge semantics and the mental model that blocks are independent contributions. Other `defaultOptions` fields (`model`, `tools`) still throw on any double-set.

### 1.9 New error codes

| Code     | Meaning                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `AI1001` | Block resolver threw or returned a non-string. Inject mode aborts the dispatch; progressive mode reports back to the model as a tool error.       |
| `AI1002` | Block name collides with another block, a user tool, or uses the reserved `_block_` prefix.                   |
| `AI1003` | Block misconfigured: invalid `mode`, missing `description` on a progressive block, non-string non-function `value`, etc.       |

---

## 2. Tools: tag selectors removed, function-form added

The `{ tagged }` and `{ tagged, from }` selector variants on `tools()` are gone, along with the `tags` override on `directTool({ tags })`.

**The implicit-extension risk is identical between the deleted tag selector and the new builder form.** In both, a future fn registered with a matching tag silently extends the agent's surface. The deletion does not eliminate the risk; it relocates it. The reason this is still worth doing: a declarative selector embedded in framework config (`{ tagged: "read-only" }`) reads as a static piece of configuration to a reviewer, while a `.filter()` in user code reads as obviously dynamic. The risk surfaces at the call site where a code review can spot it, instead of being implicit in the framework's interpretation of a tag.

For the cases where enumeration is impractical, `tools()` now accepts a builder function that receives a `ToolsCatalog` snapshot:

**Before (0.5.x):**

```ts
agent({
  tools: tools([{ tagged: "read-only" }]),
});
```

**After (0.6.0), explicit (recommended):**

```ts
agent({
  tools: tools(["fetchOrder", "getCustomer", "listOrders"]),
});
```

**After (0.6.0), programmatic escape hatch:**

```ts
agent({
  tools: tools((catalog) =>
    catalog.fns
      .filter((f) => f.tags?.includes("read-only"))
      .map((f) => f.name),
  ),
});
```

The builder receives `{ fns, routes, mcp }`, each a readonly frozen array of `{ name | id | server+tool, description?, tags? }` (entries are deep-frozen so a builder cannot mutate the snapshot). It must return the same `ToolsItem[]` the array form accepts (strings or `{ name, guard?, description? }` objects). Builder errors are wrapped in `RC5003` with the original chained.

### 2.1 `directTool({ tags })` override removed

The `tags` option on `ToolBuilderOverrides` was only meaningful for the now-removed tag selectors. `directTool(routeId, { description, input })` still works for per-binding overrides.

---

## 3. HTTP: option type renamed for the two-sided adapter

`http()` is now a two-sided adapter: the existing destination (`http({ url })`) plus a new source (`http({ path })`) that exposes a route over HTTP. To follow the Server/Client naming convention for two-sided adapters, the destination's option type is renamed:

- `HttpOptions<T>` -> `HttpClientOptions<T>`

The new source side uses `HttpServerOptions`. This is a type-only change. The `http({...})` factory, its overloads, and runtime behaviour are unchanged, so the only update needed is on explicit type imports.

**Before (0.5.x):**

```ts
import { http, type HttpOptions } from "@routecraft/routecraft";

const opts: HttpOptions<MyBody> = {
  method: "POST",
  url: "https://api.example.com/ingest",
};
```

**After (0.6.0):**

```ts
import { http, type HttpClientOptions } from "@routecraft/routecraft";

const opts: HttpClientOptions<MyBody> = {
  method: "POST",
  url: "https://api.example.com/ingest",
};
```

If you never imported `HttpOptions` by name (the common case, since `http({...})` infers its argument type), no change is needed. See the [`http()` adapter reference](/docs/reference/adapters/http) for the new source surface.

---

## 4. Mail: envelope moves from `body` to `routecraft.mail.*` headers {% #mail-envelope-headers %}

The mail **source** (`.from(mail(folder, options))`) used to deliver one fat object on `exchange.body` that mixed the message content (`body.text`, `body.html`, `attachments`) with the envelope (`from`, `to`, `subject`, `date`, `cc`, `bcc`, `replyTo`, `messageId`, `flags`, `sender`, `rawHeaders`). It now follows the same payload-on-`body`, envelope-on-`headers` convention as the HTTP source:

- **`exchange.body`** is a `MailBody`: just `{ text?, html?, attachments? }`. Attachments are message content, so they stay on the body.
- **`exchange.headers`** carries the envelope under the `routecraft.mail.*` namespace. The keys are declaration-merged into `RoutecraftHeaders` for autocomplete and exported on the `MailHeaders` key object (`MailHeaders.FROM`, `MailHeaders.SUBJECT`, ...; see [section 12](#12-header-keys-per-adapter-objects)).

Two things this unlocks: `.input({ body })` on a mail route now validates against the message content alone (no need to model envelope fields), and `mail -> transform -> http` collapses to one mental model.

Only the streaming **source** changes. The fetch destination (`.enrich(mail(...))`) still returns `MailMessage[]` with the whole envelope on each element, because a batch fetch cannot split N envelopes across single-valued headers. The send destination input (`MailSendPayload`) is unchanged.

### 4.1 Reading the envelope

**Before (0.5.x):**

```ts
craft()
  .from(mail("INBOX", { unseen: true }))
  .transform((msg) => ({
    to: "team@example.com",
    subject: `Fwd: ${msg.subject}`,
    text: msg.body.text ?? "",
  }))
  .to(mail());
```

**After (0.6.0):**

```ts
craft()
  .from(mail("INBOX", { unseen: true }))
  // The transformer's second argument is the exchange; read the envelope
  // off its headers. The first argument (the body) is now the MailBody.
  .transform((body, ex) => ({
    to: "team@example.com",
    subject: `Fwd: ${ex.headers["routecraft.mail.subject"]}`,
    text: body.text ?? "",
  }))
  .to(mail());
```

The field-to-header mapping:

| Before (`ex.body.*`) | After (`ex.headers[...]`)        |
| -------------------- | -------------------------------- |
| `body.from`          | `routecraft.mail.from`           |
| `body.to`            | `routecraft.mail.to` (array)     |
| `body.cc`            | `routecraft.mail.cc` (array)     |
| `body.bcc`           | `routecraft.mail.bcc` (array)    |
| `body.subject`       | `routecraft.mail.subject`        |
| `body.date`          | `routecraft.mail.date`           |
| `body.messageId`     | `routecraft.mail.messageId`      |
| `body.replyTo`       | `routecraft.mail.replyTo`        |
| `body.flags`         | `routecraft.mail.flags`          |
| `body.sender`        | `routecraft.mail.sender`         |
| `body.rawHeaders`    | `routecraft.mail.rawHeaders`     |
| `body.uid`           | `routecraft.mail.uid` (already)  |
| `body.folder`        | `routecraft.mail.folder` (already) |
| `body.text`          | `body.text` (unchanged)          |
| `body.html`          | `body.html` (unchanged)          |
| `body.attachments`   | `body.attachments` (unchanged)   |

### 4.2 Filtering on the effective sender

**Before (0.5.x):**

```ts
.filter((ex) => ex.body.sender?.trust === "verified")
```

**After (0.6.0):**

```ts
.filter((ex) => ex.headers["routecraft.mail.sender"]?.trust === "verified")
```

### 4.3 Downstream IMAP operations are unaffected

`.to(mail({ action: "move", ... }))` and the other IMAP operations already resolved their target from the `routecraft.mail.uid` / `routecraft.mail.folder` headers (or a custom `target` extractor), so chains like `mail source -> filter -> mail move` keep working without change.

---

## 5. Events: fixed names, identity in the payload

Every hierarchical event name loses its identity segment. The payload already carried `routeId` (and now always does), so subscriptions become exact names plus payload filtering.

| Old name | 0.6.0 name |
| --- | --- |
| `route:<id>:registered` / `:starting` / `:started` / `:stopping` / `:stopped` | `route:registered` / `route:starting` / `route:started` / `route:stopping` / `route:stopped` |
| `route:<id>:error` / `route:<id>:error:caught` | `route:error` / `route:error:caught` |
| `route:<id>:exchange:started` / `:completed` / `:failed` / `:dropped` / `:restored` | `route:exchange:started` / `:completed` / `:failed` / `:dropped` / `:restored` |
| `route:<id>:step:started` / `:completed` / `:failed` | `route:step:started` / `:completed` / `:failed` |
| `route:<id>:step:<label>:error` | `route:step:error` (step label is `details.operation`) |
| `route:<id>:batch:started` / `:flushed` / `:stopped` | `route:batch:started` / `:flushed` / `:stopped` |
| `route:<id>:error-handler:invoked` / `:recovered` / `:failed` | `route:error-handler:invoked` / `:recovered` / `:failed` |
| `route:<id>:cache:hit` / `:miss` / `:stored` / `:failed` | `route:cache:hit` / `:miss` / `:stored` / `:failed` |
| `route:<id>:operation:choice:matched` / `:unmatched` | `route:operation:choice:matched` / `:unmatched` |
| `route:<id>:agent:*` (all agent events) | `route:agent:*` (same suffixes) |
| `plugin:<pluginId>:starting` / `:started` / `:stopping` / `:stopped` | `plugin:starting` / ... (`pluginId` in payload); `plugin:<pluginId>:registered` is removed (subscribe to `plugin:starting`) |
| `context:*`, `auth:*`, `agent:registered`, `agent:tool:registered` | unchanged |

Migrate by table lookup, not regex: several route ids contain words like `batch` or `started`, and a regex will corrupt names (`route:my-batch:stopped` must become `route:stopped`, but `route:r1:batch:stopped` must become `route:batch:stopped`).

**Per-route subscriptions** use the `forRoute()` helper (or filter on `details.routeId`):

```ts
// Before
ctx.on('route:orders:exchange:failed', ({ details }) => alert(details.error))

// After (0.6.0)
import { forRoute } from '@routecraft/routecraft'
ctx.on('route:exchange:failed', forRoute('orders', ({ details }) => alert(details.error)))
```

**Wildcard patterns** are removed from `ctx.on()` / `ctx.once()`. The only pattern is the catch-all `"*"`, which observes every event. Patterns like `route:*` or `route:**` now throw `RC2001` with migration guidance.

```ts
// Before: ctx.on('route:*:exchange:*', handler) / ctx.on('**', handler)
ctx.on('*', (payload) => sink.write(payload._event, payload.details))
```

The `event()` **source adapter** keeps its pattern support (`event('route:*')` still works there); patterns match against the emitted name behind a single catch-all subscription.

**Ecosystem events** are declared by merging into `EventDetailsMap` (the same pattern as `StoreRegistry`):

```ts
declare module '@routecraft/routecraft' {
  interface EventDetailsMap {
    'plugin:myext:thing:happened': { routeId: string; thing: string }
  }
}
```

## 6. Sources: the `Subscription` object

`CallableSource` collapses from five positional parameters to one object. Everything you had is still there under a named field, plus `complete()` replaces the abort-to-finish idiom:

```ts
// Before
async subscribe(context, handler, abortController, onReady) {
  onReady?.()
  while (!abortController.signal.aborted) {
    await handler(await poll(), { 'x-origin': 'poll' })
  }
  abortController.abort() // finite source done
}

// After (0.6.0)
async subscribe(sub: Subscription<T>) {
  sub.ready()
  while (!sub.signal.aborted) {
    await sub.emit({ message: await poll(), headers: { 'x-origin': 'poll' } })
  }
  sub.complete() // finite source done
}
```

Field map: `context` -> `sub.context`, `handler(msg, headers, parse, parseFailureMode)` -> `sub.emit({ message, headers, parse, parseFailureMode })`, `abortController.signal` -> `sub.signal`, `abortController.abort()` -> `sub.complete(reason?)`, `onReady?.()` -> `sub.ready()`, `meta` -> `sub.meta` (now always present).

New since the same release, built on this contract:

```ts
// Generator sources: each yield is one exchange
.from(async function* (sub) {
  while (!sub.signal.aborted) yield await poll()
})

// Bare (async) iterables work too
.from(someAsyncIterable)
```

For driving a source directly in unit tests, `@routecraft/testing` adds `testSubscription({ context, handler, abortController })`.

## 7. Custom steps and aggregators

`Step.execute` no longer receives the remaining steps and the engine queue. Steps return what happened; the executor schedules:

```ts
// Before
async execute(exchange, remainingSteps, queue) {
  const next = DefaultExchange.rewrap(exchange, { body: transform(exchange.body) })
  queue.push({ exchange: next, steps: remainingSteps })
}

// After (0.6.0)
async execute(exchange: Exchange): Promise<StepOutcome> {
  const next = DefaultExchange.rewrap(exchange, { body: transform(exchange.body) })
  return { kind: 'continue', exchange: next }
}
```

Outcomes: `continue` (run remaining steps), `complete` (skip remaining steps, success), `drop` (halted; emit your drop events and `markDropped` first), `branch` (prepend steps, then remaining), `fanOut` (schedule each child). Join-style steps consume pending siblings via the `StepContext` second argument (`ctx.takePending(predicate)`).

Wrapper authors (`WrapperStep` subclasses): `runInner(exchange, ctx)` now returns the inner's `StepOutcome` and there is no `innerQueue` buffer to manage; recovery returns a substitute outcome.

Custom **aggregators** return the combined body (plus optional headers) instead of a fake exchange:

```ts
// Before: return { ...exchanges[0], body: merged } as Exchange
// After:
.aggregate((exchanges) => ({ body: merge(exchanges.map((e) => e.body)) }))
```

## 8. Error codes: `AI` namespace

`@routecraft/ai`'s agent-block codes moved out of core and were renumbered:

| Old code | 0.6.0 code | Meaning |
| --- | --- | --- |
| `RC5025` | `AI1001` | Agent block resolution failed |
| `RC5026` | `AI1002` | Agent block name collision |
| `RC5027` | `AI1003` | Agent block misconfigured |

Update any code or alerting that matches on `error.rc`. Core `RC####` codes are otherwise unchanged (one addition: `RC1003`, error-code registration failed).

Ecosystem packages can now own codes under a claimed namespace:

```ts
declare module '@routecraft/routecraft' {
  interface ErrorCodeRegistry {
    ACME1001: RCMeta
  }
}
registerErrorCodes('ACME', { ACME1001: { ... } }, 'my-package')
```

Namespaces are claimable by exactly one package; `RC` is reserved for core; codes are the namespace plus four digits.

## 9. Builder position is type-enforced

`craft()` returns a pre-`from` builder exposing only the staging methods (`id`, `title`, `description`, `input`, `output`, `tag`, `batch`, `authorize`, route-scope `error` / `cache`) plus `.from()`. Pipeline operations before `.from()` no longer compile (they were already `RC2001` / `RC2002` runtime errors):

```ts
// Compile error now (was a runtime error)
craft().transform(fn).from(source)

// Correct order
craft().id('orders').from(source).transform(fn)
```

Builder generics also moved to a state bag. If you annotate builder types, `RouteBuilder<T>` becomes `RouteBuilder<{ body: T }>`; for heterogeneous lists of finished builders use `AnyRouteBuilder`. DSL extensions via `registerDsl` augment `StepBuilderBase<S extends BuilderState>` and advance the bag with `Retyped<this, SetBody<S, NewBody>>`.

## 10. Splitters return bodies

`.split()` callbacks return the child values; the framework builds the child exchanges (fresh id, inherited headers, split hierarchy). Per-child header overrides use the `splitChild` envelope:

```ts
// Before: hand-built child Exchange instances
.split((exchange) => exchange.body.items.map((item) =>
  DefaultExchange.rewrap(exchange, { body: item })))

// After (0.6.0): return the bodies
.split((exchange) => exchange.body.items)

// Per-child header overrides
.split((exchange) => exchange.body.lines.map((line, i) => splitChild(line, { 'x-line': i })))
```

## 11. Consumer SPI: envelopes and a deps bag

Custom `Consumer` implementations construct from one `ConsumerDeps` object and register a handler that receives the same `Message` envelope sources enqueue:

```ts
// Before
class MyConsumer implements Consumer {
  constructor(context, definition, channel, options) { ... }
  register(handler) {
    this.channel.setHandler((m) => handler(m.message, m.headers, m.parse, m.parseFailureMode))
  }
}

// After (0.6.0)
class MyConsumer implements Consumer {
  constructor(deps: ConsumerDeps) { ... } // { context, definition, channel, options }
  register(handler: (envelope: Message) => Promise<Exchange>) {
    this.channel.setHandler(handler)
  }
}
```

`Message`, `ProcessingQueue`, `ConsumerType`, and `ConsumerDeps` are exported from the barrel. `deps.options` is `unknown`; the consumer owns narrowing its own options.

## 12. Header keys: per-adapter objects

`HeadersKeys` now carries framework keys only (`ID`, `OPERATION`, `ROUTE_ID`, `CORRELATION_ID`, `SPLIT_HIERARCHY`, `AUTH_PRINCIPAL`). Adapter keys live on per-adapter objects exported next to each adapter:

| Old | New |
| --- | --- |
| `HeadersKeys.TIMER_*` | `TimerHeaders.*` |
| `HeadersKeys.CRON_*` | `CronHeaders.*` |
| `HeadersKeys.FILE_LINE` / `FILE_PATH` | `FileHeaders.LINE` / `FileHeaders.PATH` |
| `HeadersKeys.CSV_ROW` / `CSV_PATH` | `CsvHeaders.ROW` / `CsvHeaders.PATH` |
| `HeadersKeys.JSONL_LINE` / `JSONL_PATH` | `JsonlHeaders.LINE` / `JsonlHeaders.PATH` |
| `HEADER_MAIL_UID`, `HEADER_MAIL_FROM`, ... | `MailHeaders.UID`, `MailHeaders.FROM`, ... |
| `HEADER_CARDDAV_UID`, ... | `CarddavHeaders.UID`, ... |

The wire keys (`routecraft.timer.time`, `routecraft.mail.uid`, ...) are unchanged, so code that used raw strings keeps working. `HeaderKeysRegistry` is removed: adapters and ecosystem packages declare typed headers by merging into `RoutecraftHeaders` directly. The whole `routecraft.*` header namespace is reserved; `.header()` now rejects every engine-owned key (`routecraft.id`, `routecraft.operation`, `routecraft.route`, `routecraft.split_hierarchy`) up front.

## 13. Client and capability discovery

`CraftClient.send` is renamed `sendDirect`, and its response generic defaults to `unknown` (narrow explicitly):

```ts
// Before
const result = await client.send<Req, Res>('greet', { name })

// After (0.6.0)
const result = await client.sendDirect<Req, Res>('greet', { name })
```

Capability discovery is public API: `context.capabilities()` returns every discoverable direct endpoint with its route's metadata (`endpoint`, `title`, `description`, `input`, `output`, `tags`). The internals it replaces (`ADAPTER_DIRECT_REGISTRY`, `getDirectChannel`, `sanitizeEndpoint`, `DirectRouteMetadata`) are no longer exported.

Request/reply drops now surface as errors: when the target route discards the exchange (a filter rejects it, or an error handler returns `recovery.drop()`), `client.sendDirect()` and the error-handler `forward()` callable reject with `RC5031` instead of silently resolving with the caller's own request body as the "response".

## 14. Renames: Carddav casing and JsonlFileOptions

Acronyms in identifiers are cased as words (`Http` precedent), so every `CardDAV*` export is now `Carddav*`: `CarddavAdapter`, `CarddavClientManager`, `CarddavOptions`, `CarddavAction`, `CarddavDriverClient`, `CarddavTargetExtractor`, `CarddavWriteResult`, `CarddavDeleteResult`, `CarddavContextConfig`, `CarddavAccountConfig`, `throwCarddavError`, `ResolvedCarddavConnection`. `CARDDAV_CLIENT_MANAGER` and `DEFAULT_CARDDAV_SERVER_URL` are unchanged.

The jsonl adapter folds its file options into one type, matching `JsonFileOptions` / `CsvFileOptions`: `JsonlSourceOptions`, `JsonlDestinationOptions`, and `JsonlCombinedOptions` become `JsonlFileOptions` (discriminated by `mode`, plus `chunked`). Call sites are unchanged; only type annotations need the new name.

## 15. What is new in 0.6.0

For context, no migration required:

- **HTTP source adapter.** `http({ path, method? })` exposes a route over HTTP, configured via `defineConfig({ http: { port, host, auth } })`. Bun runtimes bind via `Bun.serve`; Node 22+ uses a `node:http` shim. Global auth (`jwt()` / `jwks()` bearer or `apiKey({...})`), per-route `.authorize()`, built-in `/health`, `/ready`, and `/openapi.json` endpoints. See the [`httpPlugin`](/docs/reference/plugins/httpplugin) reference.
- `skills({ source, mode?, lifetime? })` and `fromFile(path)` builders alongside the new `Blocks` shape.
- Nested block groups: a `blocks` value may be a `BlockBody` leaf or a nested `Blocks` group, flattened by `__` (see [1.2b](#1-2b-grouping-skills-under-one-key)).
- `agent:block:loaded` / `agent:block:error` context events.
- `AgentResult.blocksLoaded`.
- `tools((catalog) => [...])` builder form with `ToolsCatalog` shape.
- New error codes (`RC5018`, `RC5019` for HTTP; `AI1001`-`AI1003` for agent blocks, see [section 8](#8-error-codes-ai-namespace); `RC1003` for error-code registration).
- **Recovery directives**: `.error()` handlers (route scope and step scope) may return `recovery.drop(reason?)` to discard the failing exchange (emits `route:exchange:dropped`) or `recovery.rethrow()` to decline recovery, instead of recovering with a body or throwing manually.
- **`rcError` retryable override**: `rcError(code, cause, { retryable })` flips the retry classification for one occurrence.
- **Open categories and kinds**: `RCMeta.category` and `Principal.kind` accept ecosystem-defined strings alongside the known values.
- **Plugin identity**: plugins may declare `name` (used as `pluginId` on events and logs) and reserve `dependsOn` for future ordered initialisation. Note: a plugin instance that already carried an unrelated string `name` property now reports that value as its `pluginId` instead of the constructor name; rename the property or set `name` to the id you want. `context.getRoutes()` returns a copy.
