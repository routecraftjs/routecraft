# @routecraft/os

System-native host capabilities for Routecraft: drive the host machine from route pipelines. This is the home for capabilities that are neither standard protocols nor vendor products, things that touch the host, carry heavy or native peers, and have a security surface.

## Available now

- `agentBrowser()` -- browser automation via [agent-browser](https://github.com/nichochar/agent-browser). Migrated here from the former `@routecraft/browser` package.

## Planned

- `shell()` -- run shell commands, sandboxed by default, sharing only the environment variables the route node declares it needs.
- `sandbox()` -- sandboxed execution as a first-class concept.
- Host primitives such as clipboard, notifications, filesystem-watch, and process management.

See [`.standards/package-boundaries.md`](https://github.com/routecraftjs/routecraft/blob/main/.standards/package-boundaries.md) for why these live together and the secure-by-default contract.

## Installation

```bash
# Bun (recommended)
bun add @routecraft/os agent-browser

# npm / pnpm / yarn
npm install @routecraft/os agent-browser
pnpm add @routecraft/os agent-browser
yarn add @routecraft/os agent-browser
```

`agent-browser` is an optional peer dependency. The `agentBrowser()` adapter loads it lazily, so it is optional at install time but required at runtime for that adapter.

## `agentBrowser(command, options?)`

Creates a `Destination` adapter. Use it with `.to()`, `.enrich()`, or `.tap()`.

```typescript
import { craft, simple, ContextBuilder } from '@routecraft/routecraft';
import { agentBrowser } from '@routecraft/os';

const scrape = craft()
  .id('scrape-page')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .to(agentBrowser('get', { info: 'text', selector: 'h1' }));

const ctx = new ContextBuilder().routes([scrape]).build();
await ctx.start();
```

### Commands

| Command | Required Options | Description |
|---------|-----------------|-------------|
| `open` | `url` | Navigate to a URL |
| `click` | `selector` | Click an element |
| `dblclick` | `selector` | Double-click an element |
| `fill` | `selector`, `value` | Fill an input field |
| `type` | `selector`, `value` | Type text into an element |
| `press` | `key` | Press a keyboard key |
| `hover` | `selector` | Hover over an element |
| `focus` | `selector` | Focus an element |
| `select` | `selector`, `value` | Select a dropdown option |
| `check` | `selector` | Check a checkbox |
| `uncheck` | `selector` | Uncheck a checkbox |
| `scroll` | `direction` | Scroll the page (`up`, `down`, `left`, `right`) |
| `snapshot` | -- | Get an accessibility snapshot |
| `screenshot` | -- | Take a screenshot |
| `eval` | `js` | Evaluate JavaScript in the page |
| `get` | `info` | Get page data (`text`, `html`, `value`, `title`, `url`, `count`, `attr`, `box`, `styles`) |
| `wait` | -- | Wait for a selector or timeout |
| `close` | -- | Close the browser session |
| `back` | -- | Navigate back |
| `forward` | -- | Navigate forward |
| `reload` | -- | Reload the page |
| `tab` | -- | Manage tabs (`new`, `close`, `list`, switch by index) |

### Base options

Every command also accepts these shared options:

| Option | Type | Description |
|--------|------|-------------|
| `session` | `string \| (ex) => string` | Override the auto-derived session ID |
| `headed` | `boolean` | Run the browser in headed mode (show window) |
| `json` | `boolean` | Parse output into `result.parsed` |
| `args` | `string[]` | Extra CLI flags (escape hatch) |

### Resolvable options

String options like `url`, `selector`, and `value` accept either a static value or a function that receives the exchange:

```typescript
// Static
agentBrowser('open', { url: 'https://example.com' })

// Dynamic from exchange body
agentBrowser('open', { url: (ex) => ex.body.targetUrl })
```

### Session management

Sessions are derived from the exchange ID by default, so each exchange gets an isolated browser. Override with the `session` option to share a browser across exchanges:

```typescript
agentBrowser('open', { url: 'https://example.com', session: 'shared' })
```

### Result shape

```typescript
interface AgentBrowserResult {
  stdout: string;     // Text output from the command
  parsed?: unknown;   // Parsed JSON (when json: true)
  exitCode: number;   // 0 on success, 1 on failure
}
```

## Migrating from `@routecraft/browser`

`@routecraft/browser` has been folded into `@routecraft/os`. Update the import:

```diff
- import { agentBrowser } from '@routecraft/browser';
+ import { agentBrowser } from '@routecraft/os';
```

The factory, options, and result shape are unchanged.

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
