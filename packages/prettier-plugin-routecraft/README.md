# @routecraft/prettier-plugin-routecraft

Prettier plugin that keeps Routecraft DSL chains compact and readable.

Prettier's defaults push fluent sub-route closures onto their own line and add
an extra level of indentation for every nested `.choice()`, `.when()`, and
`.otherwise()`. This plugin overrides Prettier's printer for those closures so
the threaded parameter stays on the arrow line and the chain keeps a single
indent level.

## Before and after

```ts
// Prettier default
.choice((c) =>
  c
    .when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) =>
      b
        .enrich(agent("zoe"), only((r) => r, "agent"))
        .to(mail({ action: "move" })),
    )
    .otherwise((b) => b),
)

// With @routecraft/prettier-plugin-routecraft
.choice((c) => c
  .when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) => b
    .enrich(agent("zoe"), only((r) => r, "agent"))
    .to(mail({ action: "move" })))
  .otherwise((b) => b))
```

## Installation

```bash
# Bun (recommended)
bun add -D @routecraft/prettier-plugin-routecraft prettier

# npm / pnpm / yarn
npm install --save-dev @routecraft/prettier-plugin-routecraft prettier
pnpm add -D @routecraft/prettier-plugin-routecraft prettier
yarn add -D @routecraft/prettier-plugin-routecraft prettier
```

## Requirements

- Prettier >= 3

## Usage

Add the plugin to your Prettier configuration:

```js
// prettier.config.mjs
export default {
  plugins: ["@routecraft/prettier-plugin-routecraft"],
};
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

## What it touches

The plugin only changes single-parameter arrow closures whose body threads that
parameter straight into a fluent chain rooted at `craft()`, for example
`(c) => c.when(...).otherwise(...)` or `(b) => b.enrich(...).to(...)`. Everything
else (including ordinary `arr.map((x) => x.foo())` chains) is left to Prettier's
defaults. Async arrows and arrows with explicit return types or type parameters
are also left untouched so no type information is ever dropped.

## Documentation

For more information about Routecraft, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
