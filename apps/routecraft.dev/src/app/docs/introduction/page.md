---
title: Introduction
---

What RouteCraft is and how it works. {% .lead %}

## What is RouteCraft?

RouteCraft is a **code-first automation platform** for TypeScript that bridges traditional integration (Software 1.0) and AI-native workflows (Software 3.0).

Whether you need to process a daily CSV on a cron job, route incoming webhooks, or give Claude the ability to manage your Google Calendar, RouteCraft handles it all through a single, unified DSL.

RouteCraft is built for both eras of software:

- **Traditional Automation:** Build robust data pipelines, process webhooks, and run scheduled tasks with a type-safe DSL.
- **AI-Native Tools:** Expose those exact same capabilities to Claude, ChatGPT, Cursor, and other agents via MCP.

TypeScript all the way. Full IDE support, version controlled, and testable.

**Safe by Design**
Free-thinking models should not have free reign over your system. RouteCraft inverts the default: nothing is accessible until you explicitly write a capability for it. Write a **deterministic** capability for predictable, code-controlled actions. Write a **non-deterministic** one and the agent reasons within the boundary you defined. Either way, you stay in control.

![RouteCraft as mission control: AI agents on the left connect via MCP, RouteCraft capabilities in the center, Software 1.0 systems on the right via Adapters, and outbound MCP clients below](/diagrams/architecture.png)

---

## Core Concepts

These concepts give you a high-level map of how everything fits together.

### Capabilities and Routes

From an AI agent's perspective, everything you build is a **Capability**: a discoverable action it can invoke, like "send an email" or "book a meeting." Under the hood, each capability is implemented as a **Route**: a TypeScript pipeline connecting a **source** to one or more **steps** (operations, processors, or adapters), and eventually to a **destination**.

Capabilities can be fully **deterministic** (the same input always produces the same output) or **non-deterministic** (an embedded agent reasons and decides at runtime). You choose the level of autonomy for each one.

### The DSL

RouteCraft uses a **fluent DSL (Domain-Specific Language)** to author capabilities. It reads like a pipeline:

```ts
craft()
  .from(source)
  .transform(fn)
  .to(destination)
```

This makes capabilities easy to write, read, and extend.

### Operations

Operations are the **steps inside a capability**. They can transform data, filter messages, enrich responses with external calls, or split and aggregate streams. They are the verbs of the DSL: `transform`, `filter`, `enrich`, and more.

### Adapters

Adapters are **connectors** that let your capabilities interact with the outside world. They come in different types:

- **Sources**: where data enters (HTTP requests, timers, files).
- **Processors**: steps that modify or enrich the exchange.
- **Destinations**: where the data ends up (logs, databases, APIs).

Adapters make RouteCraft extensible. You can use the built-ins or create your own.

### Exchange

Every step passes along an **exchange**. An exchange carries the **body** (the main data) and **headers** (metadata such as IDs, parameters, or context). It is the message envelope that moves through the pipeline from start to finish.

```json
{
  "id": "a3f4e1b2-9c6d-4e8a-b1f3-2d7c0e5a9f12",
  "body": {
    "to": "alice@example.com",
    "subject": "Your meeting is confirmed"
  },
  "headers": {
    "routecraft.correlation_id": "abc-123"
  }
}
```

### Context

The **RouteCraft context** is the runtime that manages your capabilities. It handles:

- Loading capabilities.
- Starting and stopping them.
- Hot reload in development.
- Running a capability once for batch jobs or tests.

You can drive a context through the CLI, or embed it programmatically in your own application.

### How it all fits

- **Capabilities** are the secure workflows.
- **DSL** is how you describe them.
- **Operations** are the steps.
- **Adapters** connect to the outside world.
- **Exchange** is the data that flows through.
- **Context** is the engine that runs everything.

These concepts make RouteCraft a **developer-first automation framework**: straightforward to start, and powerful enough to grow with your needs.

---

## Related

{% quick-links %}

{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="Install via CLI or manually add packages." /%}
{% quick-link title="Project structure" icon="presets" href="/docs/introduction/project-structure" description="Nuxt-style folder layout and auto-discovery." /%}
{% quick-link title="Capabilities" icon="plugins" href="/docs/introduction/capabilities" description="Author small, focused capabilities using the DSL." /%}

{% /quick-links %}