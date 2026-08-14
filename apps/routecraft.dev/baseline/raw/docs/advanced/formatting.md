# Formatting

Keep Routecraft DSL chains compact with the Prettier plugin.

Routecraft recommends formatting projects with
`@routecraft/prettier-plugin-routecraft`. It overrides Prettier's layout for
fluent builder closures so sub-pipeline path builders inside `.choice()` and
`.multicast()` keep their parameter on the arrow line instead of indenting a
level for every closure:

```ts
.choice(
  when(isUrgent, (b) => b.to(urgent)),
  otherwise((b) => b),
)
```

## Installation

**bun:**
```bash
bun add -d prettier @routecraft/prettier-plugin-routecraft
```

**npm:**
```bash
npm install -D prettier @routecraft/prettier-plugin-routecraft
```

**pnpm:**
```bash
pnpm add -D prettier @routecraft/prettier-plugin-routecraft
```

**yarn:**
```bash
yarn add -D prettier @routecraft/prettier-plugin-routecraft
```

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

- [Linting](/docs/advanced/linting) -- Enforce Routecraft authoring best practices with ESLint.

- [Operations reference](/docs/reference/operations) -- The choice, split, and aggregate operations the plugin formats.
