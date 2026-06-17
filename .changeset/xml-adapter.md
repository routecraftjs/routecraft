---
"@routecraft/routecraft": minor
"@routecraft/cli": patch
---

Add the `xml` adapter: read, write, and transform XML through a plain-object representation, mirroring the `json` and `csv` codec adapters. Works as a transformer (parse an XML string in the body), a source (read and parse a file), a returning destination (`mode: 'read'`), a write destination, and a `delete` destination. Malformed XML surfaces as an observable per-exchange `RC5016` failure honouring `onParseError` (`fail` / `abort` / `drop`). `fast-xml-parser` is loaded as an optional peer dependency through `loadOptionalPeer` (missing install reports `RC5017` with an install hint) and bundled by the CLI.
