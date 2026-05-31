---
title: title
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
title(value: string): RouteBuilder<Current>
```

Set a human-readable title for the next route. Mirrored into the `direct` / `mcp` registries so discovery consumers (agents, MCP clients, docs) can display it alongside the id. Place before `from()`.

```ts
craft()
  .id('ingest')
  .title('Ingest orders')
  .from(direct())
  .to(saveOrder)
```
