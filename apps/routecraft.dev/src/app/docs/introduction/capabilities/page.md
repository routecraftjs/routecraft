---
title: Capabilities
---

Define what your AI can do, and exactly how it does it. {% .lead %}

## What is a capability?

A capability is a TypeScript file that defines a secure, type-safe action your system can perform. It uses the RouteCraft DSL to wire a **source** through **operations** to a **destination**.

```ts
// capabilities/send-email.ts
import { craft, http, smtp } from "@routecraft/routecraft";

export default craft()
  .id("send-email")
  .from(http({ path: "/send", method: "POST" }))
  .transform((body) => ({ to: body.recipient, subject: body.subject }))
  .to(smtp());
```

When an AI agent calls `send-email`, it executes exactly this pipeline. You define the boundary; the agent works within it.

## The DSL

Every capability follows the same shape:

```ts
craft()
  .id("capability-id")   // Unique identifier
  .from(source)          // Where data enters
  .transform(fn)         // Optional operations
  .to(destination)       // Where data goes
```

`.id()` is what identifies the capability at runtime, not the filename. Name your files descriptively, but the ID is what matters.

## Source types

The `.from()` adapter determines how a capability is triggered:

**Request-driven** -- responds to an inbound call and returns a result:

```ts
.from(http({ path: "/users", method: "GET" }))
```

**Scheduled** -- runs on a timer, no caller to respond to:

```ts
.from(timer({ intervalMs: 60_000 }))
```

**One-shot** -- processes a fixed payload and completes:

```ts
.from(simple({ report: "daily-summary" }))
```

**Channel-driven** -- receives messages from another capability:

```ts
.from(direct("incoming-jobs", {}))
```

## Operations

Operations are the steps between source and destination. They are composable and run in order:

| Operation | What it does |
| --- | --- |
| `.transform(fn)` | Replaces the body with the return value of `fn` |
| `.filter(fn)` | Drops the exchange if `fn` returns false |
| `.tap(adapter)` | Side effect (logging, metrics) without altering the exchange |
| `.sample({ every: n })` | Passes through every nth exchange |
| `.batch({ size: n })` | Groups exchanges before passing them on |

## Destinations

`.to()` sends the processed exchange to its final target:

```ts
.to(log())                              // Print to console
.to(http({ url: "https://api.com" }))  // POST to external API
.to(json({ path: "./output.json" }))   // Write to file
.to(direct("next-stage"))              // Hand off to another capability
```

## Inter-capability communication

Capabilities can pass data to each other using `direct()`. This keeps each capability focused on a single concern:

```ts
// capabilities/fetch-orders.ts
export default craft()
  .id("fetch-orders")
  .from(timer({ intervalMs: 300_000 }))
  .transform(fetchNewOrders)
  .to(direct("process-orders"));

// capabilities/process-orders.ts
export default craft()
  .id("process-orders")
  .from(direct("process-orders", {}))
  .transform(fulfillOrder)
  .to(log());
```

## Testing

Capabilities are plain TypeScript -- test them with any standard framework. See the [Testing guide](/docs/introduction/testing) for patterns using `spy()` and `CraftContext`.
