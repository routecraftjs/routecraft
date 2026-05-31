---
title: split
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
split<Item = Current extends Array<infer U> ? U : never>(
  fn?: Splitter<Current, Item> | (exchange: Exchange<Current>) => Exchange<Item>[]
): RouteBuilder<Item>
```

Fan-out into multiple exchanges. Use `.split(adapter | (exchange) => Exchange[])` so splitters can be exchange-aware. Each returned exchange is processed independently.

If no splitter is provided, array bodies are split into one exchange per element; non-array bodies become a single exchange. The framework maintains `routecraft.split_hierarchy` headers for aggregation.

```ts
// Split array automatically
.split() // [1, 2, 3] becomes three exchanges: 1, 2, 3

// Exchange-aware: extract nested array and return exchanges
.split((exchange) =>
  exchange.body.items.map((body) =>
    new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })
  )
)

// Split string by delimiter (return exchanges)
.split((exchange) =>
  exchange.body.split(",").map((body) =>
    new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })
  )
)
```

**Key behaviors:**
- Splitter receives the full exchange and returns an array of exchanges
- Framework overlays `routecraft.split_hierarchy` and assigns new ids
- Each split exchange is processed independently; aggregate to combine results
