---
title: Project structure
---

A conventional folder layout that Routecraft expects out of the box. {% .lead %}

## Folder layout

Each capability is its own folder, grouped under a domain folder. `route.ts` is the
capability's public surface; everything else in the folder is private to it.

```text
my-app
├── craft.config.ts
├── capabilities
│   ├── comms
│   │   └── send-email
│   │       ├── route.ts
│   │       ├── route.test.ts
│   │       └── README.md
│   └── reports
│       └── daily-summary
│           ├── route.ts
│           ├── route.test.ts
│           ├── summarise.ts          # internal helper, private to this capability
│           └── __fixtures__
├── shared
│   └── amount.ts                     # pure helper shared by several capabilities
├── adapters
│   └── google-sheets.ts
├── plugins
│   └── logger.ts
├── package.json
├── tsconfig.json
└── .env
```

All application code can live at the project root or inside an optional `src` folder.
Routecraft treats both layouts identically.

## The capability folder

A capability is a folder under `capabilities/`, named for its id, grouped beneath a domain
folder. `bunx create-routecraft` scaffolds this shape for you.

| File | Purpose |
| --- | --- |
| `route.ts` | The public surface. Default-exports the capability and re-exports its input/output types. The only file other capabilities may import. |
| `route.test.ts` | Colocated test, written with `@routecraft/testing`. |
| `README.md` | Short description of what the capability does. Add a mermaid diagram and an integrations table for non-trivial ones. |
| internal files | Mappers, helpers, fixtures. Private to the folder; never imported from outside it. |

The file is named `route.ts` because that is what the `craft()` builder returns. The
user-facing noun for the unit of work is still "capability"; "route" is just the name of the
public-surface file.

```ts
// capabilities/comms/send-email/route.ts
import { craft, http } from '@routecraft/routecraft'
import { z } from 'zod'

export const SendEmailInput = z.object({ to: z.string().email(), subject: z.string() })
export type SendEmailInput = z.infer<typeof SendEmailInput>

export default craft()
  .id('send-email')
  .input({ body: SendEmailInput })
  .from<SendEmailInput>(/* source */)
  .to(http({ method: 'POST', url: 'https://api.example.com/send' }))
```

### Reuse between capabilities

Capabilities never import each other's internal files. To call one capability from another,
use [`direct()`](/docs/advanced/composing-capabilities) with the callee's id, and import its
types from its `route.ts`:

```ts
// capabilities/reports/daily-summary/route.ts
import { craft, direct } from '@routecraft/routecraft'
import { type SendEmailInput } from '../../comms/send-email/route'

export default craft()
  .id('daily-summary')
  .from(/* ... */)
  .to(direct<SendEmailInput>('send-email'))
```

This keeps the contract (the id plus the exported types) the only coupling between
capabilities. Internals stay free to change.

### Shared helpers

A helper used by a single capability stays inside that capability's folder. When two or more
capabilities need the same pure helper (validate an amount, parse a date, a shared domain
type), put it in a top-level `shared/` folder next to `capabilities/`:

```text
shared
├── amount.ts          # parseAmount, assertPositive
└── dates.ts           # toIsoDate
```

Any capability may import from `shared/`. Keep it pure: validators, parsers, formatters, and
types, with no side effects and no imports back into a capability's internals. `shared/` is the
single-project answer, so a one-app repo never needs workspace tooling just to share a date
parser.

When the repo grows into multiple runtimes (several apps under `apps/`), shared code graduates
from `shared/` to a workspace package that each app depends on as a local dependency, so the
boundary stays explicit across app lines.

### Single-file shorthand

A trivial capability with no internal files can be a single file, `capabilities/<id>.ts`,
that default-exports the route. This is fine for small or example-only capabilities. The
folder shape is the default once a capability grows a test, a README, or any private helper.

Sub-folders inside `capabilities/` are supported to any depth. The capability id set in
`.id()` is what identifies it at runtime, not the path or filename.

## Other folders

| Folder | Purpose |
| --- | --- |
| `shared/` | Pure helpers (validators, parsers, formatters, shared types) used by two or more capabilities in a single-app project. No side effects; never imports a capability's internals. Graduates to a workspace package once the repo goes multi-app. |
| `adapters/` | Custom adapters that connect to external systems. Each implements one of the adapter interfaces: `subscribe`, `send`, or `process`. |
| `plugins/` | Runtime plugins that hook into the Routecraft context lifecycle, such as MCP transport or custom telemetry. |

**Adapters vs plugins:** an adapter connects to an external system (a queue, an API, a file
system). A plugin extends the runtime itself (exposing MCP, adding metrics, wiring up
observability).

## Files

| File | Purpose |
| --- | --- |
| `craft.config.ts` | Registers plugins and configures the context. Exported as default. |
| `package.json` | Dependencies and convenience scripts. |
| `tsconfig.json` | TypeScript configuration. |
| `.env` | Environment variables. Pass a custom path with `--env` in CLI commands. |

## craft.config.ts

The config file is the entry point for the Routecraft runtime. A minimal setup:

```ts
// craft.config.ts
import type { CraftConfig } from "@routecraft/routecraft";

const config: CraftConfig = {};

export default config;
```

---

## Related

{% quick-links %}

{% quick-link title="Composing Capabilities" icon="presets" href="/docs/advanced/composing-capabilities" description="Reuse capabilities with direct() and exported contract types." /%}
{% quick-link title="Configuration reference" icon="presets" href="/docs/reference/configuration" description="craft.config.ts options and context settings." /%}

{% /quick-links %}
