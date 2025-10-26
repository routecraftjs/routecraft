---
title: Sample Metrics
---

Collect system metrics every second but only save every 10th one. {% .lead %}

{% callout type="warning" %}
This example uses the `json()` adapter and `sample()` operation which are planned for a future release. It serves as a reference for the intended API design. Check the [Adapters documentation](/docs/reference/adapters) and [Operations documentation](/docs/reference/operations) for currently available features.
{% /callout %}

```ts
import { craft, timer, json } from '@routecraft/routecraft'

export default craft()
  .id('sample-metrics')
  .from(timer({ intervalMs: 1000 }))
  .process(() => ({
    timestamp: Date.now(),
    cpu: process.cpuUsage().user,
    memory: process.memoryUsage().used
  }))
  .sample({ every: 10 })
  .to(json({ path: './metrics.json', mode: 'append' }))
```

## Input Data

Timer triggers every 1000ms (1 second), generating metrics like:

```json
{ "timestamp": 1705312800000, "cpu": 125000, "memory": 134217728 }
{ "timestamp": 1705312801000, "cpu": 130000, "memory": 134234112 }
{ "timestamp": 1705312802000, "cpu": 128000, "memory": 134250496 }
```

## What It Does

1. Timer generates metrics every second
2. Process function collects CPU and memory usage
3. `sample({ every: 10 })` only keeps every 10th metric
4. Saves selected metrics to JSON file

## Result

Only every 10th metric gets saved to `./metrics.json`:

```json
{ "timestamp": 1705312800000, "cpu": 125000, "memory": 134217728 }
{ "timestamp": 1705312810000, "cpu": 135000, "memory": 134283264 }
{ "timestamp": 1705312820000, "cpu": 142000, "memory": 134316032 }
```

**Storage reduction:** 86,400 metrics/day → 8,640 saved (90% less storage).
