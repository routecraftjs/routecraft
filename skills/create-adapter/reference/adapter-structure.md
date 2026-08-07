# Adapter structure and naming convention

Read this before writing an adapter. It is the layout, factory, and options-naming convention every Routecraft adapter follows, built-in or user-written. Following it means anyone can tell, at a glance, which roles an adapter plays and how to call it. The public guide with runnable code is the [custom adapters page](https://routecraft.dev/docs/advanced/custom-adapters); this file is the convention checklist.

## The role model

Roles are directional, and the operation keyword selects the role:

| Role | Slot | Operation | Contract |
| --- | --- | --- | --- |
| `Source<T>` | `subscribe(sub)` | `.from()` | streams exchanges IN |
| `Destination<T>` | `send(exchange, ctx?)` | `.to()` / `.tap()` | pushes OUT per exchange; strictly **void**, the body flows through unchanged |
| `Enricher<T, R>` | `fetch(exchange, ctx?)` | `.enrich()` (also `.to()` / `.tap()`) | pulls a value IN per exchange |
| `Transformer` | `transform(body)` | `.transform()` | reshapes the body |

`.to()` and `.tap()` prefer `send` when both slots exist and fall back to `fetch`; a fetch result replaces the body in `.to()` and is discarded by `.tap()`. Bare `.enrich()` replaces the body with the fetched value (aggregators such as `only()` merge instead).

A `send` that produces a receipt (message id, etag, created-resource URL) surfaces it via `ctx.setHeader(key, value)` on the `SendContext`; the `.to()` step merges the collected headers onto the continuing exchange. Never return data from `send`: an adapter whose purpose is to produce data implements `Enricher` (instead, or additionally).

## One folder per adapter concept

A non-trivial adapter is a folder named for its concept (`http`, `cron`, `mail`), with one file per role plus shared wiring:

```text
adapters/
  <concept>/
    index.ts          # public factory + exports (the only file consumers import)
    types.ts          # exported option and result types
    source.ts         # {Concept}SourceAdapter       (present only if it can be a .from() source)
    destination.ts    # {Concept}DestinationAdapter  (present only if it can be a .to()/.tap() push-out)
    enricher.ts       # {Concept}EnricherAdapter     (present only if it can be an .enrich() pull-in)
    transformer.ts    # {Concept}TransformerAdapter  (present only if it transforms bodies)
    shared.ts         # option parsing / helpers shared between the role files
```

The files present are the documentation. A folder with `source.ts`, `destination.ts`, and `enricher.ts` is visibly a three-role adapter; one with only `source.ts` is source-only. Adding a role later means adding a file, not reshaping the existing ones.

A trivial single-role adapter with no shared helpers and no separate types may be a single file, `adapters/<concept>.ts`. The folder shape is the default once it grows a second role, shared helpers, or a types module.

## One factory per concept, dispatched by payload

Expose exactly one factory function per concept, named for the lowercase concept (`http`, `cron`). The same function serves every role; it decides which shape to return from the arguments it receives, never from a separate import:

```ts
// one import, all roles; the position in the route selects the role
import { myQueue } from "./adapters/my-queue";

route.from(myQueue({ queue: "orders" }));  // subscribe
route.to(myQueue({ queue: "results" }));   // send
```

Rules:

- Overload by key *presence* (`"url" in options`, `"path" in options`), `arguments.length`, or `typeof`. Never by inspecting an option's *value*.
- The factory returns the interface type (`Source<T>`, `Destination<T>`, `Enricher<T, R>`) or an honest combined type intersecting the roles it carries (`Source<string> & Destination<unknown> & Enricher<unknown, string>` for a file-like adapter). Never the concrete class.
- No `mode` option and no per-role type aliases (`{Concept}ReadAdapter`): the operation keyword picks the role. Send-behavior variants are boolean flags (`append?: boolean`, `delete?: boolean`) defaulting to the primary behavior; validate mutually exclusive flags at construction and throw `RC5003`.
- A flag that changes the emitted type (`chunked: true`) is typed against the literal `true`, so a widened `boolean` is a compile error.
- Do not ship `myQueueSource` / `myQueueDestination` as separate exports. Users think in concepts, not roles.
- Tag every return path with `tagAdapter(instance, factory, factoryArgs(...))` so the adapter is mockable. A multi-role factory tags at each branch.

Class names carry the role: `{Concept}{Role}Adapter` (`HttpEnricherAdapter`, `CronSourceAdapter`, `FileDestinationAdapter`), even for single-role adapters, so adding a role later stays additive.

## Options naming

Option type names follow a fixed convention so a reader knows the side from the type name. Interfaces use Source/Destination/Enricher; option *types* use Server/Client:

| Type | Meaning |
| --- | --- |
| `{Concept}BaseOptions` | fields shared by every role |
| `{Concept}ServerOptions extends {Concept}BaseOptions` | options for the source / `.from()` side |
| `{Concept}ClientOptions extends {Concept}BaseOptions` | options for the client / `.to()` / `.enrich()` side |
| `{Concept}Options` | the exported union `{Concept}ServerOptions \| {Concept}ClientOptions`; the factory's parameter type |

Both role types carry the base, since the base is what both roles share. A role that adds nothing of its own can alias the base directly (`type {Concept}ClientOptions = {Concept}BaseOptions`). If the two roles share no fields at all, declare each independently and skip the base. The internal intersection used for stored or merged options (`{Concept}ServerOptions & {Concept}ClientOptions`) stays unexported. A single-role adapter needs only `{Concept}Options`, plus an optional `{Concept}Result`.

## Before you submit

- The folder has one file per role it plays, plus `index.ts` and, when non-trivial, `types.ts`.
- One factory, named for the lowercase concept, dispatching by payload shape (key presence, never values), returning the interface type.
- `send` is void; receipts go through `ctx?.setHeader(...)`. Data production lives in `fetch`.
- Classes named `{Concept}{Role}Adapter`; every factory return path tagged with `tagAdapter(...)`.
- Option types follow the Base / Server / Client / union convention; no `mode` enums, no per-role aliases.
- Full walkthrough with code: https://routecraft.dev/docs/advanced/custom-adapters
