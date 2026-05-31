---
title: cosine
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { cosine } from '@routecraft/routecraft'
```

Comparator that groups items by cosine similarity of a numeric vector field. Pass it to `group({ comparator: cosine(options) })`.

```ts
.transform(group({
  comparator: cosine({ field: 'embedding', threshold: 0.85 }),
  from: (body) => body.items,
}))
```

**Options (`CosineOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `field` | `string` | Yes | Property on each item holding the embedding vector (`number[]`) |
| `threshold` | `number` | No | Items cluster when their cosine similarity is strictly greater than this value (default: `0.82`) |

Items whose `field` is not an array never match.

---
