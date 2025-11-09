# @routecraft/eslint-plugin-routecraft

ESLint plugin for RouteCraft projects with rules to enforce best practices.

## Installation

```bash
npm install --save-dev @routecraft/eslint-plugin-routecraft eslint
```

or

```bash
pnpm add -D @routecraft/eslint-plugin-routecraft eslint
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

- `routecraft/require-named-route` — Enforce `.id(<non-empty string>)` before `.from()` in a `craft()` chain
- `routecraft/batch-before-from` — Enforce `batch()` is used as a route-level operation before `.from()`

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

For more information about RouteCraft, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)

