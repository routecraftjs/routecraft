---
title: Linting
---

Enforce Routecraft best practices with ESLint. {% .lead %}

## Installation

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

The plugin ships two presets:

| Preset | Description |
|--------|-------------|
| `routecraftPlugin.configs.recommended` | Recommended rules at their default levels |
| `routecraftPlugin.configs.all` | All rules enabled as errors |

Use `recommended` for most projects. Use `all` if you want to enforce every rule strictly from the start.

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
      '@routecraft/routecraft/mcp-server-options': 'off',
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
