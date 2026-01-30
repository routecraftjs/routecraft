---
title: Introduction
---

What RouteCraft is and how it works. {% .lead %}

## What is RouteCraft?

RouteCraft is an open source automation and integration framework for TypeScript. It is built for developers who prefer writing code instead of wiring together boxes in a UI. Workflows should feel like part of your codebase, simple, readable, and under version control.

Unlike black box automation tools, RouteCraft is transparent. Every route is just TypeScript, so you can test it, commit it, and run it anywhere from your laptop to the cloud.

RouteCraft is AI native. That means three things:
1. You can call AI models and agents inside your routes as first class steps.
2. You can expose a route to an agent as a tool or as an MCP server.
3. The DSL is predictable and repeatable, which makes it easy for generative AI to create and maintain routes you can trust and verify.

In short, RouteCraft combines the reliability of code with the flexibility of automation. It makes AI a collaborator rather than a mystery box.

---

## Core Concepts

These concepts give you a high-level map of how everything fits together.

### Routes

A **route** is the heart of RouteCraft. It connects a **source** to one or more **steps** (operations, processors, or adapters), and eventually to a **destination**. Think of a route as a small, focused workflow, like "fetch data from an API, transform it, then log the result."

### The DSL

RouteCraft uses a **fluent DSL (Domain-Specific Language)** to define routes.  
It reads like a pipeline:

```ts
craft()
  .from(source)
  .transform(fn)
  .to(destination)
```

This makes routes easy to write, easy to read, and easy to extend.

### Operations

Operations are the **steps inside a route**. They can transform data, filter messages, enrich with external calls, or split and aggregate streams. They are the verbs of the DSL, like `transform`, `filter`, `enrich`, and `to`.

### Adapters

Adapters are **connectors** that let your routes interact with the outside world.  
They come in different types:

- **Sources**: where data enters (HTTP requests, timers, files).
- **Processors**: steps that modify or enrich the exchange.
- **Destinations**: side effects, where the data ends up (logs, databases, APIs).
- **Taps**: like logging or metrics, without changing the flow.

Adapters make RouteCraft extendable. You can use built-ins or create your own.

### Exchange

Every step in a route passes along an **exchange**. An exchange carries the **body** (the main data) and **headers** (metadata like IDs, params, or context). It's the message envelope that moves through your route from start to finish.

### Context

The **RouteCraft context** is the runtime that manages your routes.  
It knows how to:

- Load routes.
- Start and stop them.
- Handle hot reload in development.
- Run a route once for jobs or tests.

You can run a context with the CLI, or embed it programmatically in your own app.

### How it all fits

- **Routes** are the workflows.
- **DSL** is how you describe them.
- **Operations** are the steps.
- **Adapters** connect to the outside world.
- **Exchange** is the data that flows through.
- **Context** is the engine that runs everything.

Together, these concepts make RouteCraft a **developer-first automation and integration framework** that is simple to start with but powerful to extend.

---

{% quick-links %}

{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="Install via CLI or manually add packages." /%}
{% quick-link title="Project structure" icon="presets" href="/docs/introduction/project-structure" description="Nuxt‑style folder layout and discovery." /%}
{% quick-link title="Routes" icon="plugins" href="/docs/introduction/routes" description="Author small, focused routes using the DSL." /%}
{% quick-link title="Testing" icon="plugins" href="/docs/introduction/testing" description="Unit and E2E patterns for routes." /%}
{% quick-link title="Deployment" icon="presets" href="/docs/introduction/deployment" description="Local, Docker, and cloud notes." /%}
{% quick-link title="Monitoring" icon="theming" href="/docs/introduction/monitoring" description="Logging and observability hooks." /%}

{% /quick-links %}
