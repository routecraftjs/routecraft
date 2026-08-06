---
title: html
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
html(options: HtmlOptions): Transformer   // no path: extract from the HTML string in the body
html(options: HtmlOptions & { path }): HtmlAdapter   // Source<HtmlResult> & Destination<unknown> & Enricher<unknown, HtmlResult>
```

Extract data from HTML using CSS selectors (powered by cheerio), or read/write HTML files. The presence of `path` selects the file roles; the operation keyword then picks one: `.from()` reads and extracts, `.to()` writes, `.enrich()` extracts mid-route. Without `path`, `html()` is a transformer over the body.

**Transformer role** (in-memory HTML parsing):
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

**Source role** (read HTML files and extract):
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

**Read mid-route** (extract from an HTML file partway through a route): The adapter is also an enricher whose `fetch` reads the file and extracts via the selector, so `.enrich()` can pull the result in. The extracted value replaces the body; pass an aggregator such as `only()` to merge instead. The fetch role accepts dynamic (function) paths. Extraction failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to the source role only).

```ts
// Replace the body with the extracted value
.enrich(html({ path: './page.html', selector: 'title' }))

// Enrich the body with a value extracted from a file, keeping existing fields
.enrich(
  html({ path: './page.html', selector: 'h1' }),
  only((title) => title, 'title'),
)
```

**Destination role** (write HTML files). The send is void: the body flows through the `.to()` step unchanged.
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
  append: true
}))

// Delete an HTML file (idempotent: an already-absent path is a no-op)
.to(html({ path: (ex) => ex.body.processedPath, delete: true }))
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

All transformer options above (except `from` / `to`, which only apply to the transformer role; `selector` is optional in the send role), plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static for the source role; send/fetch also accept a function) |
| `append` | `boolean` | `false` | Send role: append instead of overwriting; mutually exclusive with `delete` |
| `delete` | `boolean` | `false` | Send role: delete the file instead of writing (idempotent); mutually exclusive with `append` |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (send role only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle an extraction failure (source role only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

Passing both `append: true` and `delete: true` throws `RC5003` at construction.

**Extract types:**
- `text` / `innerText` / `textContent`: Plain text content (strips HTML tags, removes `<style>` and `<script>`)
- `html`: Inner HTML content
- `attr`: Attribute value (requires `attr` option)
- `outerHtml`: Element including its tag

**Behavior:**
- **Single match**: Returns string
- **Multiple matches**: Returns array of strings
- **No matches**: Returns empty string
- **Source role**: Reads HTML file and extracts data using selector
- **Destination role**: Writes HTML string (from `exchange.body` or `exchange.body.body`) to file; the body flows through unchanged

**Exported types:** `HtmlAdapter`, `HtmlOptions`, `HtmlResult`
