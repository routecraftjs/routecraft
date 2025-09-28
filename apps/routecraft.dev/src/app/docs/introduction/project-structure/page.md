---
title: Project structure
---

A clear folder layout that scales from small apps to larger codebases. The tables below show the recommended structure and what each directory/file is for. {% .lead %}

## Top-level folders

| Folder | Purpose |
| --- | --- |
| `routes` | Discovered routes. Files ending in `.route.ts` or `.route.mjs` are loaded by `craft dev` and `craft start`. |
| `adapters` | Custom adapters implementing operation interfaces (`subscribe`, `send`, `process`). Keep concerns isolated. |
| `plugins` | Cross‑cutting helpers (logging, metrics, tracing). |
| `src` | Optional wrapper folder. If chosen, place the folders above inside `src`. If omitted, keep them at the project root. |

---

## Top-level files

These files can live at the project root or inside `src` if you opt into a source directory.

| File | Purpose |
| --- | --- |
| `craft.config.ts` | Exports a `CraftConfig` with `routes`. Use context events for lifecycle handling. |
| `package.json` | Scripts and dependencies. Add `craft` scripts for convenience. |
| `tsconfig.json` | TypeScript configuration. |
| `.gitignore` | VCS ignores. Ensure build outputs and environment files are ignored. |
| `.env`, `.env.local`, etc. | Environment variables. You can pass a file with `--env` in supported CLI commands. |

---

## Organizing your project

Routecraft recommends a clear, consistent structure to keep projects maintainable. Use the layout below as your baseline and adjust as needed.

### Src folder
Routecraft supports storing application code inside an optional `src` folder. This separates application code from project configuration files which mostly live in the root of a project.

### Route file types

- You can author routes in TypeScript or JavaScript: `.ts`, `.js`, `.mjs`, `.cjs`.
- Naming with a `.route.*` suffix is a recommended convention to make route files easy to identify.

### Suggested folder layout

Use either a flat layout at the project root or colocate under `src`.

```text
my-app
├── craft.config.ts
├── routes
│   ├── file-to-http.route.ts
│   ├── metrics.route.ts
│   └── users
│       └── api.route.ts
├── adapters
│   ├── kafka.ts
│   └── google-sheets.ts
├── plugins
│   └── logger.ts
├── package.json
├── tsconfig.json
└── .env
```