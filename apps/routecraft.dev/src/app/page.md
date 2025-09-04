---
title: Getting started
---

Build small, focused routes with a fluent DSL and run them anywhere. {% .lead %}

## What is RouteCraft?

RouteCraft is a developer-first framework for building automation and integration flows. You use its fluent DSL to define routes, connecting sources, processors, and destinations. RouteCraft is inspired by Apache Camel, designed for modern JavaScript developers.

It takes care of the low-level plumbing like wiring, execution, and lifecycle, so you can focus on composing clear routes instead of boilerplate code.

Whether you’re automating a single task, integrating multiple systems, or wiring in AI agents and MCP, RouteCraft helps you build reliable, reusable flows quickly.

---

## Core Concepts

Before diving into installation and examples, it helps to understand the core building blocks of RouteCraft. These concepts give you a high-level map of how everything fits together.

### Routes

A **route** is the heart of RouteCraft. It connects a **source** to one or more **steps** (operations, processors, or adapters), and eventually to a **destination**. Think of a route as a small, focused workflow, like “fetch data from an API, transform it, then log the result.”

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

Every step in a route passes along an **exchange**. An exchange carries the **body** (the main data) and **headers** (metadata like IDs, params, or context). It’s the message envelope that moves through your route from start to finish.

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