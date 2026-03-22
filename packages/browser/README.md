# @routecraft/browser

Browser automation adapter for Routecraft. Drive headless or headed browsers from capability pipelines using [agent-browser](https://github.com/nichochar/agent-browser) under the hood.

## Installation

```bash
npm install @routecraft/browser agent-browser
```

or

```bash
pnpm add @routecraft/browser agent-browser
```

`agent-browser` is a peer dependency. The adapter loads it lazily, so it is optional at install time but required at runtime.

## Quick Start

```typescript
import { craft, ContextBuilder } from '@routecraft/routecraft';
import { agentBrowser } from '@routecraft/browser';

const scrape = craft()
  .id('scrape-page')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .to(agentBrowser('get', { info: 'text', selector: 'h1' }));

const ctx = new ContextBuilder().routes([scrape]).build();
await ctx.start();
```

## Usage

`agentBrowser(command, options?)` creates a `Destination` adapter. Use it with `.to()`, `.enrich()`, or `.tap()`.

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

### Base Options

Every command also accepts these shared options:

| Option | Type | Description |
|--------|------|-------------|
| `session` | `string \| (ex) => string` | Override the auto-derived session ID |
| `headed` | `boolean` | Run the browser in headed mode (show window) |
| `json` | `boolean` | Parse output into `result.parsed` |
| `args` | `string[]` | Extra CLI flags (escape hatch) |

### Resolvable Options

String options like `url`, `selector`, and `value` accept either a static value or a function that receives the exchange:

```typescript
// Static
agentBrowser('open', { url: 'https://example.com' })

// Dynamic from exchange body
agentBrowser('open', { url: (ex) => ex.body.targetUrl })
```

### Session Management

Sessions are derived from the exchange ID by default, so each exchange gets an isolated browser. Override with the `session` option to share a browser across exchanges:

```typescript
agentBrowser('open', { url: 'https://example.com', session: 'shared' })
```

### Result Shape

Every command returns an `AgentBrowserResult`:

```typescript
interface AgentBrowserResult {
  stdout: string;     // Text output from the command
  parsed?: unknown;   // Parsed JSON (when json: true)
  exitCode: number;   // 0 on success, 1 on failure
}
```

### Examples

```typescript
// Open a page, grab the title, then close
craft()
  .id('get-title')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .enrich(agentBrowser('get', { info: 'title' }))
  .to(agentBrowser('close'));

// Take a full-page screenshot
craft()
  .id('screenshot')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .to(agentBrowser('screenshot', { full: true }));

// Fill and submit a form
craft()
  .id('login')
  .from(simple({ username: 'admin', password: 'secret' }))
  .to(agentBrowser('open', { url: 'https://app.example.com/login' }))
  .to(agentBrowser('fill', { selector: '#username', value: (ex) => ex.body.username }))
  .to(agentBrowser('fill', { selector: '#password', value: (ex) => ex.body.password }))
  .to(agentBrowser('click', { selector: 'button[type="submit"]' }));
```

## Documentation

For full guides and examples, visit [routecraft.dev](https://routecraft.dev).

## Contributing

Contributions are welcome. See the [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
