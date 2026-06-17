---
title: xml
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
xml(options?: XmlTransformerOptions): Transformer   // no path: parse an XML string in the body
xml(options: XmlFileOptions & { mode: 'read' }): XmlReadAdapter
xml(options: XmlFileOptions): XmlAdapter   // Source<XmlData> & Destination<unknown, void>
```

Read, write, and parse XML using a plain-object representation. **Requires `fast-xml-parser` as a peer dependency.**

```bash
bun add fast-xml-parser
```

XML maps to a plain object: each element becomes a key, attributes are kept under the `@_` prefix by default, and text content sits under `#text` when an element also has attributes or children. The same options drive parsing and building, so a read then write round-trip preserves structure.

**Transformer mode** (parse an XML string already in the body):
```ts
// Parse an XML string (e.g. an http() response body) into an object
.transform(xml())

// Pluck the string and write the parsed object to a sub-field
.transform(xml({
  from: (b) => b.body,
  to: (b, parsed) => ({ ...b, parsed })
}))
```

**Source mode** (read XML files):
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

**Read mid-route** (read + parse an XML file partway through a route): In `read` mode the adapter is also a destination whose `send` reads and parses the file and returns the object, so `.enrich()` / `.to()` can pull it in, the same way an HTTP `GET` returns a body. Read-as-destination accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to source mode only).

```ts
// Enrich the body with the parsed document, keeping the existing fields
.enrich(
  xml({ path: './config.xml', mode: 'read' }),
  only((doc) => doc, 'config'),
)

// Replace the body with the parsed document
.to(xml({ path: './data.xml', mode: 'read' }))
```

**Destination mode** (write XML files):
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
.to(xml({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
```

There is no `append` mode: appending a serialized fragment to an XML file produces multiple root elements and an invalid document. Read the file in `read` mode, mutate the parsed object, and write it back instead.

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

**File Options** (when `path` is provided): all parse options above (except `from` / `to`), plus:

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `path` | `string \| (exchange) => string` | | Yes | File path (static, or dynamic for destinations) |
| `encoding` | `BufferEncoding` | `'utf-8'` | No | Text encoding |
| `mode` | `'read' \| 'write' \| 'delete'` | `'read'` for source, `'write'` for destination | No | File operation mode (`read` returns the parsed object mid-route; `delete` removes the file, idempotently) |
| `createDirs` | `boolean` | `false` | No | Create parent directories (write mode only) |
| `format` | `boolean` | `false` | No | Pretty-print the written XML (write mode only) |
| `indentBy` | `string` | `'  '` | No | Indentation unit when `format` is true |
| `suppressEmptyNode` | `boolean` | `false` | No | Collapse empty nodes to self-closing tags when building |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | No | How to handle a parse failure (source only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Behavior:**
- **Source**: Reads the file and emits the parsed object. Malformed XML is routed through the route's `.error()` handler by default (`onParseError: 'fail'`); `'abort'` fails the source; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination** (`write`, default): Builds the object body into an XML document and writes it. The body must be a plain object.
- **Destination** (`read`): Reads, parses, and returns the object for `.enrich()` / `.to()`.
- **Destination** (`delete`): Deletes the file (idempotent) and passes the body through unchanged.

**Peer dependency:** Requires `fast-xml-parser` to be installed separately.

**Exported symbols:** types `XmlAdapter`, `XmlReadAdapter`, `XmlOptions`, `XmlTransformerOptions`, `XmlFileOptions`, `XmlParseOptions`, `XmlBuildOptions`, `XmlData`
