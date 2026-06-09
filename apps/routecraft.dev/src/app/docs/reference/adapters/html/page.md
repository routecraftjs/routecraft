---
title: html
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
html(options: HtmlOptions): HtmlAdapter
```

Extract data from HTML using CSS selectors (powered by cheerio), or read/write HTML files.

**Transformer mode** (in-memory HTML parsing):
```ts
// Extract text from title
.transform(html({ selector: 'title', extract: 'text' }))

// Extract multiple elements (returns array)
.transform(html({ selector: 'h2', extract: 'text' }))
// Result: ['First Heading', 'Second Heading', ...]

// Extract HTML content
.transform(html({ selector: '.content', extract: 'html' }))

// Extract attribute value
.transform(html({ selector: 'a', extract: 'attr', attr: 'href' }))

// Extract outer HTML (including element tag)
.transform(html({ selector: 'article', extract: 'outerHtml' }))

// Custom parsing from sub-field
.transform(html({
  selector: 'p',
  extract: 'text',
  from: (body) => body.htmlContent,
  to: (body, result) => ({ ...body, paragraphs: result })
}))
```

**Source mode** (read HTML files and extract):
```ts
// Read HTML file and extract title
.from(html({
  path: './page.html',
  selector: 'title',
  extract: 'text'
}))

// Extract multiple links from file
.from(html({
  path: './page.html',
  selector: 'a',
  extract: 'attr',
  attr: 'href'
}))
// Emits array: ['https://example.com', '/about', ...]
```

**Read mid-route** (extract from an HTML file partway through a route): In `read` mode the adapter is also a destination whose `send` reads the file, extracts via the selector, and returns the result, so `.enrich()` / `.to()` can pull it in, the same way an HTTP `GET` returns a body. Read-as-destination accepts dynamic (function) paths. Extraction failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to source mode only).

```ts
// Enrich the body with a value extracted from a file, keeping existing fields
.enrich(
  html({ path: './page.html', selector: 'h1', mode: 'read' }),
  only((title) => title, 'title'),
)

// Replace the body with the extracted value
.to(html({ path: './page.html', selector: 'title', mode: 'read' }))
```

**Destination mode** (write HTML files):
```ts
// Write HTML string to file
.to(html({ path: './output.html' }))

// Dynamic paths with directory creation
.to(html({
  path: (exchange) => `./pages/${exchange.body.slug}.html`,
  createDirs: true
}))

// Append to HTML file
.to(html({
  path: './log.html',
  mode: 'append'
}))

// Delete an HTML file (idempotent: an already-absent path is a no-op)
.to(html({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
```

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `selector` | `string` | Required | CSS selector to match elements |
| `extract` | `'text' \| 'html' \| 'attr' \| 'outerHtml' \| 'innerText' \| 'textContent'` | `'text'` | What to extract from matched elements |
| `attr` | `string` | -- | Attribute name (required when `extract: 'attr'`) |
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract HTML string from exchange |
| `to` | `(body, result) => R` | Replaces body | Where to put extracted result |

**File Options** (when `path` is provided):

All transformer options above, plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `mode` | `'read' \| 'write' \| 'append' \| 'delete'` | `'read'` for source, `'write'` for destination | File operation mode (`read` extracts mid-route; `delete` removes the file, idempotently) |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle an extraction failure (source only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Extract types:**
- `text` / `innerText` / `textContent`: Plain text content (strips HTML tags, removes `<style>` and `<script>`)
- `html`: Inner HTML content
- `outerHtml`: Element including its tag
- `attr`: Attribute value (requires `attr` option)

**Behavior:**
- **Single match**: Returns string
- **Multiple matches**: Returns array of strings
- **No matches**: Returns empty string
- **Source mode**: Reads HTML file and extracts data using selector
- **Destination mode**: Writes HTML string (from `exchange.body` or `exchange.body.body`) to file

**Exported types:** `HtmlAdapter`, `HtmlReadAdapter`, `HtmlOptions`, `HtmlResult`
