# @routecraft/prettier-plugin-routecraft

Prettier plugin that keeps Routecraft DSL chains compact and readable.

Prettier's defaults push fluent sub-pipeline path closures onto their own line
and add an extra level of indentation for every `(b) => b...` branch builder
inside `.choice()` and `.multicast()`. This plugin overrides Prettier's printer
for those closures so the threaded parameter stays on the arrow line and the
chain keeps a single indent level.

## Before and after

```ts
// Prettier default
.choice(
  when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) =>
    b
      .enrich(agent("zoe"), only((r) => r, "agent"))
      .to(mail({ action: "move" })),
  ),
  otherwise((b) => b),
)

// With @routecraft/prettier-plugin-routecraft
.choice(
  when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) => b
    .enrich(agent("zoe"), only((r) => r, "agent"))
    .to(mail({ action: "move" }))),
  otherwise((b) => b),
)
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

The plugin only changes parameter-threaded builders: single-parameter arrow
closures whose body is a fluent chain rooted in that parameter, passed directly
as a call argument inside a `craft()` chain. Arrows such as
`(b) => b.enrich(...).to(...)` (a branch builder inside `when(...)` /
`otherwise(...)` / `multicast(...)`) keep the parameter on the arrow line
instead of breaking the body onto its own line.

Everything else is left to Prettier's defaults, including factory-rooted
callbacks such as `(ex) => direct(...).send(...)` (whose chain is rooted in a
call, not the parameter), ordinary `arr.map((x) => x.foo())` chains (no
`craft()` root), arrows used as object or array values such as adapter option
callbacks (`path: (ex) => path.join(...)`), non-chain bodies such as template
literals or object literals, and async arrows or arrows with explicit return
types or type parameters (so no type information is ever dropped).

## Documentation

For more information about Routecraft, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
