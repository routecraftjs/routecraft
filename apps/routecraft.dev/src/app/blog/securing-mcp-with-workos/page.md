---
title: Migrating an MCP server from Clerk to WorkOS AuthKit
description: Why we moved DevOptix's MCP server off Clerk's OAuth proxy and onto WorkOS AuthKit's validator-mode JWKS, plus a step-by-step migration guide and a side-by-side comparison.
date: 2026-05-30
author: Jaco Botha
authorRole: Founder, DevOptix
tags:
  - mcp
  - workos
  - authentication
  - routecraft
  - typescript
draft: true
image: /images/blog/securing-mcp-with-workos/hero.png
imageAlt: "Side-by-side architecture diagram of Clerk OAuth proxy vs WorkOS AuthKit validator-mode flow"
layout: blog-post
---

This is the second post in the series on securing Routecraft MCP servers. The [first post](/blog/securing-mcp-with-clerk) wired Clerk in as an OAuth proxy. Here we strip that out and replace it with WorkOS AuthKit running in validator mode.

> Draft placeholder. Replace with the full content before publishing.

## What we are changing

- Drop the `/authorize`, `/token`, and `/register` proxy endpoints.
- Point MCP clients directly at WorkOS AuthKit.
- Verify JWTs against WorkOS's JWKS endpoint.
- Pull richer role data from WorkOS organization memberships.

## Why move

- Validator mode is stateless. The MCP server is no longer in the OAuth flow at all.
- WorkOS organization memberships carry roles natively, no JWT template work needed.
- Better separation of concerns: auth lives at WorkOS, the MCP server only verifies.

## The migration

A full walkthrough of the changes to `craft.config.ts`, `env.ts`, and the capability layer, plus how to flip the WorkOS dashboard from Dynamic Client Registration to AuthKit.
