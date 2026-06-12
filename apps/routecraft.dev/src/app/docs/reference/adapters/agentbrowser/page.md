---
title: agentBrowser
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { agentBrowser } from '@routecraft/os'
```

Automate a browser session using the [agent-browser](https://www.npmjs.com/package/agent-browser) library. Each exchange gets an isolated session (derived from `exchange.id`), so `split()`/`aggregate()` flows work correctly. Use with `.to()`, `.enrich()`, or `.tap()`. Requires `agent-browser` as a peer dependency.

**Navigate and take a snapshot:**

```ts
import { agentBrowser } from '@routecraft/os'

craft()
  .id('scrape-page')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .enrich(agentBrowser('snapshot', { json: true }))
  .to(log())
// Result merged into body: { stdout: '...', parsed: { snapshot: '...', refs: {...} }, exitCode: 0 }
```

**Click an element and get text:**

```ts
craft()
  .id('click-and-read')
  .from(source)
  .to(agentBrowser('click', { selector: '#submit-btn' }))
  .enrich(agentBrowser('get', { info: 'text', selector: '.result' }))
  .to(log())
```

**Dynamic URL from exchange body:**

```ts
craft()
  .id('dynamic-browse')
  .from(simple({ link: 'https://example.com/page' }))
  .enrich(agentBrowser('open', { url: (ex) => ex.body.link }))
  .enrich(agentBrowser('snapshot'))
  .to(log())
```

**Close the session explicitly:**

```ts
.to(agentBrowser('close'))
```

**Commands:**

| Command | Required Options | Description |
|---------|-----------------|-------------|
| `open` | `url` | Navigate to a URL |
| `click` | `selector` | Click an element (optional `newTab`) |
| `dblclick` | `selector` | Double-click an element |
| `fill` | `selector`, `value` | Clear and fill a form field |
| `type` | `selector`, `value` | Type text into a focused element |
| `press` | `key` | Press a keyboard key |
| `hover` | `selector` | Hover over an element |
| `focus` | `selector` | Focus an element |
| `select` | `selector`, `value` | Select a dropdown option |
| `check` | `selector` | Check a checkbox |
| `uncheck` | `selector` | Uncheck a checkbox |
| `scroll` | `direction` | Scroll the page (`up`, `down`, `left`, `right`; optional `pixels`) |
| `snapshot` | | Take an accessibility snapshot (optional `interactive`) |
| `screenshot` | | Take a screenshot (optional `path`, `full`, `annotate`) |
| `eval` | `js` | Evaluate JavaScript in the page |
| `get` | `info` | Get page info: `text`, `html`, `value`, `title`, `url`, `count`, `attr`, `box`, `styles` (optional `selector`, `attr`) |
| `wait` | | Wait for a selector or timeout (optional `selector`, `ms`) |
| `close` | | Close the browser session |
| `back` | | Navigate back |
| `forward` | | Navigate forward |
| `reload` | | Reload the page |
| `tab` | | Manage tabs (optional `action`: `new`, `close`, `list`; `index`; `url`) |

Command-specific option values that accept `Resolvable<T, V>` can be a static value or a function `(exchange) => value` for dynamic resolution.

**Base options (available on every command):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `session` | `string \| (exchange) => string` | `exchange.id` | Override auto-session derived from exchange ID |
| `headed` | `boolean` | `false` | Run browser in headed mode (show window) |
| `json` | `boolean` | `false` | Parse command output into `result.parsed` |
| `args` | `string[]` | | Extra CLI flags (ignored in library mode) |

**Result shape (`AgentBrowserResult`):**

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `string` | Text output from the command |
| `parsed` | `unknown` | Parsed JSON output (only when `json: true`) |
| `exitCode` | `number` | `0` for success, `1` for failure |

---
