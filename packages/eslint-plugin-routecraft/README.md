# @routecraft/eslint-plugin-routecraft

ESLint plugin for Routecraft with rules to enforce capability authoring best practices.

## Installation

```bash
# Bun (recommended)
bun add -D @routecraft/eslint-plugin-routecraft eslint

# npm / pnpm / yarn
npm install --save-dev @routecraft/eslint-plugin-routecraft eslint
pnpm add -D @routecraft/eslint-plugin-routecraft eslint
yarn add -D @routecraft/eslint-plugin-routecraft eslint
```

## Requirements

- ESLint >= 9.0.0

## Usage

Add the plugin to your ESLint configuration:

```javascript
// eslint.config.mjs
import routecraftPlugin from '@routecraft/eslint-plugin-routecraft';

export default [
  {
    plugins: {
      routecraft: routecraftPlugin,
    },
    rules: {
      'routecraft/require-named-route': 'error',
      'routecraft/batch-before-from': 'warn',
    },
  },
];
```

## Rules

- `routecraft/require-named-route`: Enforce `.id(<non-empty string>)` before `.from()` in a `craft()` chain
- `routecraft/batch-before-from`: Enforce `batch()` is used as a route-level operation before `.from()`
- `routecraft/single-to-per-route`: Warn when a route uses more than one `.to()`
- `routecraft/capability-boundaries` (opt-in): Enforce capability module boundaries (Spring Modulith style)

### routecraft/require-named-route

```ts
// ✅ Good
craft().id('user-processor').from(source).to(dest)

// ❌ Bad
craft().from(source).to(dest)
```

### routecraft/batch-before-from

```ts
// ✅ Good: batch() before from()
craft()
  .batch({ size: 50 })
  .from(source)
  .to(dest)

// ❌ Bad: batch() after from()
craft()
  .from(source)
  .batch({ size: 50 })
  .to(dest)
```

### routecraft/capability-boundaries (opt-in)

Enforces Spring-Modulith-style module boundaries between capabilities. A capability
is any folder that contains a public-surface file (`route.ts` by default) under a
`capabilities/` directory. The route file is the capability's only public surface;
every other file in the folder is internal. From outside a capability, only its
public surface may be imported. Share across capabilities via a `direct()` route or
a shared package instead.

```
apps/agent/
  capabilities/
    index.ts                 # registry: imports each route.ts (the public surface)
    employees/               # domain grouping only (no shared code, no route.ts)
      onboard/
        route.ts             # PUBLIC SURFACE
        mapper.ts            # internal
      offboard/
        route.ts
  env.ts
packages/
  shared/                    # shared code: bare @scope/* imports, always allowed
```

```ts
// from apps/agent/capabilities/employees/onboard/route.ts

// ✅ Good
import other from "../offboard/route.js";          // sibling public surface
import { map } from "./mapper.js";                  // same capability (internal)
import { util } from "@scope/shared";               // shared package

// ❌ Bad
import { map } from "../offboard/mapper.js";         // another capability's internal
```

This rule is **opt-in**: it encodes a specific repository layout and is deliberately
excluded from both the `recommended` and `all` configs. Enable it explicitly:

```js
// eslint.config.mjs
import routecraftPlugin from "@routecraft/eslint-plugin-routecraft";

export default [
  {
    // Scope the rule to the part of the repo that follows the layout. In a
    // mixed monorepo where only one app is Routecraft, point `files` at it.
    files: ["apps/agent/**/*.{ts,tsx}"],
    plugins: { routecraft: routecraftPlugin },
    rules: {
      "routecraft/capability-boundaries": "error",
    },
  },
];
```

The rule is inert for any import that does not reach into a capability's internals,
so files outside a `capabilities/` tree are never flagged even without `files`
scoping. Two options tune it for a different layout:

| Option | Default | Description |
|--------|---------|-------------|
| `capabilitiesDir` | `"capabilities"` | Directory name that marks the capabilities root. |
| `publicSurface` | `"route.ts"` | File name that is a capability's public surface. |

```js
rules: {
  "routecraft/capability-boundaries": [
    "error",
    { capabilitiesDir: "modules", publicSurface: "api.ts" },
  ],
}
```

It resolves ESM `.js` specifiers to their `.ts` sources itself, so it needs no
`eslint-import-resolver-typescript`. Bare specifiers (`@scope/*`, framework
packages, node builtins) are always allowed. Circular-dependency detection
(`madge --circular`) is orthogonal and remains a separate check.

A capability is detected as the nearest ancestor folder that contains the
public-surface file, so domain grouping folders must not contain one themselves
(a `route.ts` directly under `employees/` would make `employees/` a capability).
Keep the public surface at the capability leaf, never at a grouping level.

## Recommended Configuration

```javascript
export default [
  {
    plugins: {
      routecraft: routecraftPlugin,
    },
    rules: {
      'routecraft/require-named-route': 'warn',
      'routecraft/batch-before-from': 'warn',
    },
  },
];
```

## Documentation

For more information about Routecraft, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)

