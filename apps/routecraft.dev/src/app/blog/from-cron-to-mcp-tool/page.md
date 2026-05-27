---
title: From cron job to MCP tool in ten lines
description: The same Routecraft capability can run on a schedule, accept webhooks, or be called by an AI agent over MCP. Here is how the source adapter swap works in practice.
date: 2026-03-21
author: Jaco Botha
authorRole: Founder, DevOptix
tags:
  - routecraft
  - mcp
  - automation
draft: true
layout: blog-post
---

> Draft placeholder. Replace with the full content before publishing.

A Routecraft capability does not care how it gets triggered. The source adapter is the only thing that changes when you move from "run this every hour" to "expose this as a tool an agent can call".

## What this post will show

- A daily inbox cleanup capability triggered by `cron()`
- The same capability triggered by `webhook()` on a Stripe event
- The same capability exposed as an MCP tool via `mcp()` with a Zod input schema
- How `defineConfig` lets you ship one binary that supports all three at once
- The trade-offs (idempotency, auth, output formatting) for each shape

The takeaway: write the business logic once, change one line to change how it is invoked.
