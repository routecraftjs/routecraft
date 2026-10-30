---
"@routecraft/ai": minor
---

A proxied tool call whose route leaves the result alone answers with the remote's result as published.

When the body a proxy route finally returns is the value its `.to(mcp(...))` hop set, unedited, the caller receives the remote's own content blocks (images and resources with their `mimeType`, several text blocks as several), its `structuredContent` with its own text block beside it when the tool advertises an output schema, and its `_meta`, instead of the body re-serialised into one text block. A route that replaces or edits the body in place keeps the existing serialisation, and a remote `isError` result still fails with `AI2003`. A client that parsed the JSON text of a multi-block proxied result reads the blocks instead.
