---
title: Formatting
---

Keep Routecraft DSL chains compact with the Prettier plugin. {% .lead %}

Prettier's defaults push fluent sub-route closures onto their own line and add a
level of indentation for every nested `.choice()`, `.when()`, and `.otherwise()`.
A small route can end up five or six levels deep. The
`@routecraft/prettier-plugin-routecraft` plugin overrides Prettier's printer for
those closures so the threaded parameter stays on the arrow line and the chain
keeps a single indent level.

## Before and after

```ts
// Prettier default
.choice((c) =>
  c
    .when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) =>
      b
        .enrich(agent('zoe'), only((r) => r, 'agent'))
        .to(mail({ action: 'move' })),
    )
    .otherwise((b) => b),
)

// With the plugin
.choice((c) => c
  .when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) => b
    .enrich(agent('zoe'), only((r) => r, 'agent'))
    .to(mail({ action: 'move' })))
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

Add the plugin to your Prettier config. Prettier loads plugins from the
`plugins` array; no other options are required.

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

## What the plugin touches

The plugin only changes single-parameter arrow closures whose body is a fluent
chain and that are passed directly as a call argument inside a `craft()` chain.
Being a direct argument inside a `craft()` chain is what scopes it to the
Routecraft DSL. There are two layouts:

- Parameter-threaded builders such as `(c) => c.when(...).otherwise(...)` and
  `(b) => b.enrich(...).to(...)` keep the parameter on the arrow line.
- Factory-rooted callbacks such as `(ex) => direct(...).send(...)` keep the
  parameter on the arrow line but break the body onto the next line.

Everything else is left to Prettier's defaults, including:

- Ordinary fluent chains such as `arr.map((x) => x.foo().bar())` (no `craft()`
  root)
- Arrows used as object or array values, such as adapter option callbacks
  (`path: (ex) => path.join(...)`)
- Non-chain bodies such as template literals or object literals
- Async arrows and arrows with explicit return types or type parameters, so no
  type information is ever dropped

The result is roundtrip stable: running Prettier twice produces no further
changes.

## Related

{% quick-links %}

{% quick-link title="Operations reference" icon="presets" href="/docs/reference/operations" description="The choice, split, and aggregate operations the plugin formats." /%}

{% quick-link title="Linting" icon="presets" href="/docs/advanced/linting" description="Enforce Routecraft authoring best practices with ESLint." /%}

{% /quick-links %}
