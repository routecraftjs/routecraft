---
title: Project structure
---

A conventional folder layout that RouteCraft expects out of the box. {% .lead %}

## Folder layout

```text
my-app
├── craft.config.ts
├── capabilities
│   ├── send-email.ts
│   ├── sync-users.ts
│   └── reports
│       └── daily-summary.ts
├── adapters
│   ├── kafka.ts
│   └── google-sheets.ts
├── plugins
│   └── logger.ts
├── package.json
├── tsconfig.json
└── .env
```

All application code can live at the project root or inside an optional `src` folder. RouteCraft treats both layouts identically.

## Folders

| Folder | Purpose |
| --- | --- |
| `capabilities/` | Your capabilities as `.ts` files. Nest them freely in sub-folders. |
| `adapters/` | Custom adapters that connect to external systems. Each implements one of the adapter interfaces: `subscribe`, `send`, or `process`. |
| `plugins/` | Runtime plugins that hook into the RouteCraft context lifecycle, such as MCP transport or custom telemetry. |

**Adapters vs plugins:** an adapter connects to an external system (a queue, an API, a file system). A plugin extends the runtime itself (exposing MCP, adding metrics, wiring up observability).

## Files

| File | Purpose |
| --- | --- |
| `craft.config.ts` | Registers plugins and configures the context. Exported as default. |
| `package.json` | Dependencies and convenience scripts. |
| `tsconfig.json` | TypeScript configuration. |
| `.env` | Environment variables. Pass a custom path with `--env` in CLI commands. |

## craft.config.ts

The config file is the entry point for the RouteCraft runtime. A minimal setup:

```ts
// craft.config.ts
import type { CraftConfig } from "@routecraft/routecraft";

const config: CraftConfig = {};

export default config;
```

Sub-folders inside `capabilities/` are supported. `capabilities/reports/daily-summary.ts` is just as valid as a flat file. The capability ID set in `.id()` is what identifies it at runtime, not the filename.
