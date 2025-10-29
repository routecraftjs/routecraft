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
    },
  },
];
```

## Rules

- [`routecraft/require-named-route`](https://routecraft.dev/docs/reference/eslint-rules#require-named-route) - Enforces that all routes have a `.routeId()` for better debuggability

## Recommended Configuration

```javascript
export default [
  {
    plugins: {
      routecraft: routecraftPlugin,
    },
    rules: {
      'routecraft/require-named-route': 'warn',
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

