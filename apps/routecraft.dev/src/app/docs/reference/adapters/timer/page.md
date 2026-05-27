---
title: timer
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
timer(options?: TimerOptions): Source<undefined>
```

Trigger routes at regular intervals or specific times. Produces `undefined` as the message body.

```ts
// Simple interval (every second)
.id('ticker')
.from(timer({ intervalMs: 1000 }))

// Limited runs (10 times, then stop)
.id('batch-job')
.from(timer({ intervalMs: 5000, repeatCount: 10 }))

// Start with delay
.id('delayed-start')
.from(timer({ intervalMs: 1000, delayMs: 5000 }))

// Daily at specific time
.id('daily-report')
.from(timer({ exactTime: '09:30:00' }))

// Fixed rate (ignore execution time)
.id('heartbeat')
.from(timer({ intervalMs: 1000, fixedRate: true }))

// Add random jitter to prevent synchronized execution
.id('distributed-task')
.from(timer({ intervalMs: 1000, jitterMs: 200 }))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `intervalMs` | `number` | `1000` | No | Time between executions in milliseconds |
| `delayMs` | `number` | `0` | No | Delay before first execution in milliseconds |
| `repeatCount` | `number` | `Infinity` | No | Number of executions before stopping |
| `fixedRate` | `boolean` | `false` | No | Execute at exact intervals ignoring processing time |
| `exactTime` | `string` | -- | No | Execute daily at time of day `HH:mm:ss` (fires once/day) |
| `timePattern` | `string` | -- | No | Custom date format for execution times |
| `jitterMs` | `number` | `0` | No | Random jitter added to each scheduled run |

**Headers added:** Timer metadata including fired time, counter, period, and next run time
