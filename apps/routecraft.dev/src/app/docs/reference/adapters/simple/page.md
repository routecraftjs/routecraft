---
title: simple
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
simple<T>(producer: (() => T | Promise<T>) | T): Source<T>
```

Create a static or dynamic data source. When the producer returns an **array**, each element becomes a separate exchange processed independently through the pipeline.

```ts
// Static value
.id('hello-route')
.from(simple('Hello, World!'))

// Array of values (each becomes a separate exchange)
.id('items-route')
.from(simple(['item1', 'item2', 'item3']))

// Dynamic function
.id('api-route')
.from(simple(async () => {
  const response = await fetch('https://api.example.com/data')
  return response.json()
}))

// With custom ID
.id('data-loader')
.from(simple(() => loadData()))
```

**Use cases:** Testing, static data, API polling, file reading
