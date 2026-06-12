---
title: Linting
---

Enforce Routecraft best practices with ESLint. {% .lead %}

## Installation

{% code-tabs %}
{% code-tab label="bun" language="bash" %}
```bash
bun add -d eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm install -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% /code-tabs %}

## Configuration

Add the plugin to your ESLint flat config and spread the recommended preset:

```js
// eslint.config.mjs
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import routecraftPlugin from '@routecraft/eslint-plugin-routecraft'

/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { '@routecraft/routecraft': routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
]
```

The `recommended` preset enables all rules at their default levels. See the [Linting reference](/docs/reference/linting) for the full rule list and defaults.

## Presets

The plugin ships two presets: `recommended` (rules at their default levels) and `all` (every rule as an error). Use `recommended` for most projects; use `all` to enforce every rule strictly from the start. Both presets cover the general convention rules; the opt-in `capability-boundaries` rule is excluded from both and must be enabled explicitly (see below). See the [Linting reference](/docs/reference/linting#presets) for the full preset and rule catalog.

## Capability boundaries (opt-in)

`capability-boundaries` enforces Spring-Modulith-style module boundaries between capabilities. A capability is any folder that contains a public-surface file (`route.ts` by default) under a `capabilities/` directory: the route file is the capability's only public surface, and everything else in the folder is internal. From outside a capability, only its public surface may be imported. Share across capabilities via a `direct()` route or a shared package instead.

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

// Good
import other from '../offboard/route.js' // sibling public surface
import { map } from './mapper.js' // same capability (internal)
import { util } from '@scope/shared' // shared package

// Bad
import { map } from '../offboard/mapper.js' // another capability's internal
```

Because the rule encodes a specific layout, it is not part of any preset. Enable it explicitly and scope it to the part of the repo that follows the convention. In a mixed monorepo where only one app is Routecraft, point `files` at that app:

```js
// eslint.config.mjs
import routecraftPlugin from '@routecraft/eslint-plugin-routecraft'

export default [
  // ... other configs
  {
    files: ['apps/agent/**/*.{ts,tsx}'],
    plugins: { '@routecraft/routecraft': routecraftPlugin },
    rules: {
      '@routecraft/routecraft/capability-boundaries': 'error',
    },
  },
]
```

The rule is inert for any import that does not reach into a capability's internals, so files outside a `capabilities/` tree are never flagged even without `files` scoping. Two options tune it for a different layout:

| Option | Default | Description |
|--------|---------|-------------|
| `capabilitiesDir` | `"capabilities"` | Directory name that marks the capabilities root. |
| `publicSurface` | `"route.ts"` | File name that is a capability's public surface. |

```js
rules: {
  '@routecraft/routecraft/capability-boundaries': [
    'error',
    { capabilitiesDir: 'modules', publicSurface: 'api.ts' },
  ],
}
```

It resolves ESM `.js` specifiers to their `.ts` sources itself, so it needs no `eslint-import-resolver-typescript`. Bare specifiers (`@scope/*`, framework packages, node builtins) are always allowed. Circular-dependency detection (`madge --circular`) is orthogonal and remains a separate check.

## Customizing severity

Override individual rules in your config to change severity or disable them:

```js
// eslint.config.mjs
export default [
  // ... other configs
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { '@routecraft/routecraft': routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
    rules: {
      // Downgrade to a warning
      '@routecraft/routecraft/require-named-route': 'warn',
      // Elevate to an error
      '@routecraft/routecraft/batch-before-from': 'error',
      // Turn off entirely
      '@routecraft/routecraft/single-to-per-route': 'off',
    },
  },
]
```

Valid severity values: `'error'`, `'warn'`, `'off'` (or `2`, `1`, `0`).

---

## Related

{% quick-links %}

{% quick-link title="Linting reference" icon="presets" href="/docs/reference/linting" description="Full rule catalog with defaults and descriptions." /%}

{% /quick-links %}
