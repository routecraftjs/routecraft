---
title: group
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { group } from '@routecraft/routecraft'
```

Transformer that groups an array into clusters using a comparator. Use with `.transform(group(options))`. By default it reads the body as the array and replaces the body with the array of clusters; use `from` / `to` to read and write sub-fields, and `map` to shape each cluster.

```ts
.transform(group({
  comparator: cosine({ field: 'embedding', threshold: 0.82 }),
  from: (body) => body.items,
  map: (cluster) => ({ size: cluster.length, first: cluster[0] }),
}))
```

**Options (`GroupOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `comparator` | `Comparator<T>` | Yes | Decides whether two items belong in the same cluster (e.g. from `cosine()`) |
| `from` | `(body) => T[]` | No | Read the array to cluster (default: the body itself) |
| `map` | `(cluster: T[]) => R` | No | Shape each resulting cluster (default: the raw cluster) |
| `to` | `(body, result: R[]) => unknown` | No | Write the clusters back (default: replace the body) |
