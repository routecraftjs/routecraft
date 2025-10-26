---
title: Batch Processing
---

Process items in groups instead of one at a time. {% .lead %}

{% callout type="warning" %}
This example uses the `json()` adapter which is planned for a future release. It serves as a reference for the intended API design. Check the [Adapters documentation](/docs/reference/adapters) for currently available adapters.
{% /callout %}

```ts
import { craft, simple, json } from '@routecraft/routecraft'

export default craft()
  .id('batch-processing')
  .batch({ size: 5, flushIntervalMs: 2000 })
  .from(simple(['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7']))
  .aggregate(items => ({
    users: items.map(item => item.body),
    count: items.length,
    batchId: Date.now()
  }))
  .to(json({ path: './batches.json', mode: 'append' }))
```

## Input Data

Array of 7 user strings from `simple()` source:

```js
['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7']
```

## What It Does

1. Takes input array of 7 users
2. `batch({ size: 5 })` groups them into batches of 5
3. `aggregate()` combines each batch into an object with metadata
4. Saves each batch to JSON file

## Result

Two separate JSON objects saved to `./batches.json`:

```json
{"users":["user1","user2","user3","user4","user5"],"count":5,"batchId":1705312800123}
{"users":["user6","user7"],"count":2,"batchId":1705312802456}
```

**Benefit:** Process many items efficiently in groups rather than one-by-one.
