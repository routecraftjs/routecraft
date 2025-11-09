---
title: Linting
---

Enforce RouteCraft best practices with ESLint. {% .lead %}

## @routecraft/eslint-plugin-routecraft

An official ESLint plugin that provides rules for RouteCraft projects.

- Package: `@routecraft/eslint-plugin-routecraft`
- Config: ESLint Flat Config

### Install

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm install -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add -D eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bun add -d eslint @eslint/js typescript-eslint @routecraft/eslint-plugin-routecraft
```
{% /code-tab %}

{% /code-tabs %}

### Configure (flat config)

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

### Rules

#### require-named-route

- **Action**: Error (default)
- **Description**: Every `craft().from()` chain must include `.id(<non-empty string>)` before `.from()` for easier debugging, monitoring, and consistency.
- **Options**: None
- **Autofix**: None (names should be descriptive, not generated)

Examples:

```ts
// ✅ Good
export default craft()
  .id('user-processor')
  .from(timer({ intervalMs: 5000 }))
  .to(log())
```

```ts
// ❌ Bad (missing .id before .from)
export default craft()
  .from(timer({ intervalMs: 5000 }))
  .to(log())
```

```ts
// ❌ Bad (empty name)
export default craft()
  .id('')
  .from(timer({ intervalMs: 5000 }))
```

#### batch-before-from

- **Action**: Warn (default)
- **Description**: `batch()` is a route-level operation and must be configured before `.from()`. Using `batch()` after `.from()` is ambiguous and won’t affect the current route.
- **Options**: None
- **Autofix**: None

Examples:

```ts
// ✅ Good: batch before from
craft()
  .id('bulk')
  .batch({ size: 50, flushIntervalMs: 5000 })
  .from(timer({ intervalMs: 1000 }))
  .to(database({ operation: 'bulkInsert' }))
```

```ts
// ❌ Bad: batch after from (will be staged for the next route, not this one)
craft()
  .id('bulk')
  .from(timer({ intervalMs: 1000 }))
  .batch({ size: 50 })
  .to(database({ operation: 'bulkInsert' }))
```

### Customizing Rule Severity

You can change the severity or disable rules in your ESLint config:

```js
// eslint.config.mjs
export default [
  // ... other configs
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { '@routecraft/routecraft': routecraftPlugin },
    rules: {
      // Warn instead of error
      '@routecraft/routecraft/require-named-route': 'warn',
      // Elevate to error
      '@routecraft/routecraft/batch-before-from': 'error',
    },
  },
]
```

```js
// Disable a rule
export default [
  // ... other configs
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { '@routecraft/routecraft': routecraftPlugin },
    rules: {
      '@routecraft/routecraft/require-named-route': 'off',
      '@routecraft/routecraft/batch-before-from': 'off',
    },
  },
]
```

### Using Configs

The plugin provides two pre-configured rule sets:

- `routecraftPlugin.configs.recommended` - Recommended rules for all RouteCraft projects
- `routecraftPlugin.configs.all` - All available rules enabled

The recommended config enables:
- `require-named-route` as error
- `batch-before-from` as warn

The all config enables both rules as errors.

