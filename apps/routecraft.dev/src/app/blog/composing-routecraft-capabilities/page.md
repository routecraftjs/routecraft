---
title: Composing Routecraft capabilities without losing your mind
description: How to break complex workflows into small composable capabilities, dispatch between them with direct(), and keep the graph testable.
date: 2026-04-12
author: Jaco Botha
authorRole: Founder, DevOptix
tags:
  - routecraft
  - patterns
  - architecture
draft: true
imageAlt: A graph diagram of Routecraft capabilities chained together via direct adapters
layout: blog-post
---

> Draft placeholder. Replace with the full content before publishing.

A Routecraft capability is a single source-to-destination route. Real automations are graphs of them. This post is about how to draw those graphs so they stay readable.

## Topics this post will cover

- The `direct()` adapter as a typed function call between capabilities
- When to use enrichment vs separate capabilities
- Testing the graph in isolation with the testing harness
- How DevOptix's Eywa MCP server composes 12+ capabilities into a coherent agent surface
- Common anti-patterns and how to refactor out of them

A worked example will walk through a small triage pipeline (mail in -> classify -> route -> respond) and show three iterations of the same logic at different granularities.
