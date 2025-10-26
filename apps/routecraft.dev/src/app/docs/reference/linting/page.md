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
    },
  },
]
```

### Using Configs

The plugin provides two pre-configured rule sets:

- `routecraftPlugin.configs.recommended` - Recommended rules for all RouteCraft projects
- `routecraftPlugin.configs.all` - All available rules enabled

Both configs currently enable `require-named-route` as an error. More rules will be added in future releases.

