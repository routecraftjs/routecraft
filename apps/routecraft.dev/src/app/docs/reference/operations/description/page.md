---
title: description
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
description(value: string): RouteBuilder<Current>
```

Set a human-readable description for the next route. Used by discovery-aware adapters when exposing the route to external consumers such as agents and MCP clients.

```ts
craft()
  .id('ingest')
  .description('Validate and persist an inbound order')
  .from(direct())
  .to(saveOrder)
```
