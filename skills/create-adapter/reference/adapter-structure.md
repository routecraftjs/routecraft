# Adapter structure and naming convention

Read this before writing an adapter. It is the layout, factory, and options-naming convention every Routecraft adapter follows, built-in or user-written. Following it means anyone can tell, at a glance, which roles an adapter plays and how to call it. The public guide with runnable code is the [custom adapters page](https://routecraft.dev/docs/advanced/custom-adapters); this file is the convention checklist.

## One folder per adapter concept

A non-trivial adapter is a folder named for its concept (`http`, `cron`, `mail`), with one file per role plus shared wiring:

```text
adapters/
  <concept>/
    index.ts          # public factory + exports (the only file consumers import)
    types.ts          # exported option and result types
    source.ts         # {Concept}SourceAdapter       (present only if it can be a .from() source)
    destination.ts    # {Concept}DestinationAdapter  (present only if it can be a .to()/.enrich()/.tap() destination)
    transformer.ts    # {Concept}TransformerAdapter  (present only if it transforms bodies)
    shared.ts         # option parsing / helpers shared between the role files
```

The files present are the documentation. A folder with both `source.ts` and `destination.ts` is visibly a two-role adapter; one with only `source.ts` is source-only. Adding a role later means adding a file, not reshaping the existing ones.

A trivial single-role adapter with no shared helpers and no separate types may be a single file, `adapters/<concept>.ts`. The folder shape is the default once it grows a second role, shared helpers, or a types module.

## One factory per concept, dispatched by payload

Expose exactly one factory function per concept, named for the lowercase concept (`http`, `cron`). The same function serves every role; it decides which role to return from the arguments it receives, never from a separate import:

```ts
// one import, both roles
import { myQueue } from "./adapters/my-queue";

route.from(myQueue({ queue: "orders" }));  // returns the source
route.to(myQueue({ queue: "results" }));   // returns the destination
```

Rules:

- Discriminate roles structurally: by `arguments.length`, `typeof`, or the shape of the options (`"consumerGroup" in options`). Never by inspecting option *values*.
- The factory returns the interface type (`Source<T>`, `Destination<T, R>`), never the concrete class.
- Do not ship `myQueueSource` / `myQueueDestination` as separate exports. Users think in concepts, not roles.
- Tag every return path with `tagAdapter(instance, factory, factoryArgs(...))` so the adapter is mockable. A multi-role factory tags at each branch.

Class names carry the role: `{Concept}{Role}Adapter` (`HttpDestinationAdapter`, `CronSourceAdapter`), even for single-role adapters, so adding a role later stays additive.

## Options naming

Option type names follow a fixed convention so a reader knows the role from the type name. Interfaces use Source/Destination; option *types* use Server/Client:

| Type | Meaning |
| --- | --- |
| `{Concept}BaseOptions` | fields shared by every role |
| `{Concept}ServerOptions extends {Concept}BaseOptions` | options for the source / `.from()` side |
| `{Concept}ClientOptions` | options for the destination / `.to()` side |
| `{Concept}Options` | the exported union `{Concept}ServerOptions \| {Concept}ClientOptions`; the factory's parameter type |

If the two roles share no fields, declare each independently and skip the base. The internal intersection used for stored or merged options (`{Concept}ServerOptions & {Concept}ClientOptions`) stays unexported. A single-role adapter needs only `{Concept}Options`, plus an optional `{Concept}Result`.

## Before you submit

- The folder has one file per role it plays, plus `index.ts` and, when non-trivial, `types.ts`.
- One factory, named for the lowercase concept, dispatching by payload shape, returning the interface type.
- Classes named `{Concept}{Role}Adapter`; every factory return path tagged with `tagAdapter(...)`.
- Option types follow the Base / Server / Client / union convention.
- Full walkthrough with code: https://routecraft.dev/docs/advanced/custom-adapters
