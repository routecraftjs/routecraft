---
title: Formatting
---

Keep Routecraft DSL chains compact with the Prettier plugin. {% .lead %}

Routecraft recommends formatting projects with
`@routecraft/prettier-plugin-routecraft`. It overrides Prettier's layout for
fluent builder closures so nested `.choice()`, `.when()`, and `.otherwise()`
chains stay shallow instead of indenting a level for every closure:

```ts
.choice((c) => c
  .when(isUrgent, (b) => b.to(urgent))
  .otherwise((b) => b))
```

## Installation

{% code-tabs %}
{% code-tab label="bun" language="bash" %}
```bash
bun add -d prettier @routecraft/prettier-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm install -D prettier @routecraft/prettier-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add -D prettier @routecraft/prettier-plugin-routecraft
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add -D prettier @routecraft/prettier-plugin-routecraft
```
{% /code-tab %}

{% /code-tabs %}

## Configuration

Add the plugin to your Prettier config:

```js
// prettier.config.mjs
export default {
  plugins: ['@routecraft/prettier-plugin-routecraft'],
}
```

Or in `.prettierrc`:

```json
{
  "plugins": ["@routecraft/prettier-plugin-routecraft"]
}
```

Then format as usual:

```bash
bunx prettier --write .
```

The plugin only adjusts Routecraft builder closures; everything else is left to
Prettier's defaults.

## Related

{% quick-links %}

{% quick-link title="Linting" icon="presets" href="/docs/advanced/linting" description="Enforce Routecraft authoring best practices with ESLint." /%}

{% quick-link title="Operations reference" icon="presets" href="/docs/reference/operations" description="The choice, split, and aggregate operations the plugin formats." /%}

{% /quick-links %}
