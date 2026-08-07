---
title: xml
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
xml(options?: XmlTransformerOptions): Transformer   // no path: parse an XML string in the body
xml<T>(options: XmlFileOptions): XmlAdapter<T>   // Source<T> & Destination<unknown> & Enricher<unknown, T>
```

Read, write, and parse XML using a plain-object representation. With `path`, the operation keyword selects the role: `.from()` reads, `.to()` writes, `.enrich()` reads mid-route. **Requires `fast-xml-parser` as a peer dependency.**

"Presence" means the key was **supplied**, not that it holds something truthy. Only an omitted `path` selects the transformer role; a supplied `path` that is empty or `undefined` is refused with `RC5003` rather than silently demoted to a transformer that would ignore every file option passed alongside it.

```bash
bun add fast-xml-parser
```

XML maps to a plain object: each element becomes a key, attributes are kept under the `@_` prefix by default, and text content sits under `#text` when an element also has attributes or children. The same options drive parsing and building, so a read then write round-trip preserves structure.

**Transformer role** (parse an XML string already in the body):
```ts
// Parse an XML string (e.g. an http() response body) into an object
.transform(xml())

// Pluck the string and write the parsed object to a sub-field
.transform(xml({
  from: (b) => b.body,
  to: (b, parsed) => ({ ...b, parsed })
}))
```

**Source role** (read XML files):
```ts
// Read and parse an XML file
.from(xml({ path: './data.xml' }))
// <note><to>Alice</to></note> -> { note: { to: 'Alice' } }

// Coerce values and strip namespace prefixes
.from(xml({
  path: './data.xml',
  parseAttributeValue: true,
  removeNSPrefix: true,
}))
```

**Read mid-route** (read + parse an XML file partway through a route): The adapter is also an enricher whose `fetch` reads and parses the file, so `.enrich()` can pull the object in. The parsed object replaces the body; pass an aggregator such as `only()` to merge instead. The fetch role accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to the source role only).

```ts
// Replace the body with the parsed document
.enrich(xml({ path: './data.xml' }))

// Enrich the body with the parsed document, keeping the existing fields
.enrich(
  xml({ path: './config.xml' }),
  only((doc) => doc, 'config'),
)
```

**Destination role** (write XML files). The send is void: the body flows through the `.to()` step unchanged.
```ts
// Build the object body into an XML document and write it
.to(xml({ path: './output.xml' }))
// { note: { to: 'Alice' } } -> <note><to>Alice</to></note>

// Pretty-print with indentation
.to(xml({ path: './output.xml', format: true }))

// Dynamic paths with directory creation
.to(xml({
  path: (exchange) => `./reports/${exchange.body.reportDate}.xml`,
  createDirs: true,
}))

// Delete an XML file (idempotent: an already-absent path is a no-op)
.to(xml({ path: (ex) => ex.body.processedPath, delete: true }))
```

There is no `append` option: appending a serialized fragment to an XML file produces multiple root elements and an invalid document. Read the file with `.enrich()`, mutate the parsed object, and write it back instead.

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `from` | `(body) => string` | Uses `body` or `body.body` | No | Extract the XML string from the exchange |
| `to` | `(body, parsed) => R` | Replaces body | No | Where to put the parsed object |
| `ignoreAttributes` | `boolean` | `false` | No | Drop XML attributes from the output |
| `attributeNamePrefix` | `string` | `'@_'` | No | Prefix for attribute keys |
| `textNodeName` | `string` | `'#text'` | No | Property name for element text content |
| `cdataPropName` | `string` | (merged into text) | No | Property name for CDATA sections |
| `parseAttributeValue` | `boolean` | `false` | No | Coerce attribute values to number / boolean |
| `parseTagValue` | `boolean` | `true` | No | Coerce tag text to number / boolean |
| `trimValues` | `boolean` | `true` | No | Trim whitespace around values |
| `removeNSPrefix` | `boolean` | `false` | No | Strip namespace prefixes from names |
| `isArray` | `(tagName, jPath, isLeafNode, isAttribute) => boolean` | (occurrence-based) | No | Force matching tags to always parse as arrays. Without it a tag that appears once parses as an object and repeated occurrences parse as an array; return `true` to pin a repeatable element to a stable array shape |

**File Options** (when `path` is provided): all parse options above (except `from` / `to`), plus:

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `path` | `string \| (exchange) => string` | | Yes | File path (static, or dynamic for the send/fetch roles) |
| `encoding` | `BufferEncoding` | `'utf-8'` | No | Text encoding |
| `delete` | `boolean` | `false` | No | Send role: delete the file instead of writing (idempotent) |
| `createDirs` | `boolean` | `false` | No | Create parent directories (send role only) |
| `format` | `boolean` | `false` | No | Pretty-print the written XML (send role only) |
| `indentBy` | `string` | `'  '` | No | Indentation unit when `format` is true |
| `suppressEmptyNode` | `boolean` | `false` | No | Collapse empty nodes to self-closing tags when building |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | No | How to handle a parse failure (source role only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Behavior:**
- **Source**: Reads the file and emits the parsed object. Malformed XML is routed through the route's `.error()` handler by default (`onParseError: 'fail'`); `'abort'` fails the source; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination** (default): Builds the object body into an XML document and writes it; the body flows through unchanged. The body must be a plain object with exactly one root element (an optional `?xml` declaration key is allowed alongside it); arrays and multi-root objects are rejected because they would serialise to an invalid multiple-root document.
- **Destination** (`delete: true`): Deletes the file (idempotent) and passes the body through unchanged.
- **Enricher**: Reads, parses, and returns the object for `.enrich()`.

**Peer dependency:** Requires `fast-xml-parser` to be installed separately.

**Exported symbols:** types `XmlAdapter`, `XmlOptions`, `XmlTransformerOptions`, `XmlFileOptions`, `XmlParseOptions`, `XmlBuildOptions`, `XmlData`
