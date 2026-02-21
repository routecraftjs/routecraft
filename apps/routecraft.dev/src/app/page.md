---
title: Getting started
---

Get up and running with RouteCraft in 60 seconds. {% .lead %}

## Give AI Access, Not Control

Build automation that AI can use—without giving it your entire system.

### Code Your Automation
Write TypeScript routes that define exactly what AI can do. Send emails, manage calendars, automate tasks. All from code you write and control.

### Works with Any AI Agent
Expose your routes as tools via MCP. Works with Claude Desktop, ChatGPT, Cursor, or any MCP client. Your AI discovers them automatically and calls them when needed.

### Safe by Design
AI only accesses the routes you explicitly code. No filesystem access, no shell commands. You control everything.

---

## Play Online

Try RouteCraft in your browser without installing anything:

{% quick-links %}

{% quick-link title="Open on CodeSandbox" icon="installation" href="https://codesandbox.io/p/sandbox/github/routecraftjs/craft-playground?file=%2Froutes%2Fhello-world.route.ts" description="Play around with RouteCraft in your browser." /%}

{% /quick-links %}

## Create a new project

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest my-app
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft my-app
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest my-app
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft my-app
```
{% /code-tab %}

{% /code-tabs %}

## Start the development server

```bash
cd my-app
npm run dev
```

You should see your routes start and log output in your terminal.

## Your first route

The starter project includes a hello world route at `routes/hello-world.route.ts`. It demonstrates the core flow:

1. **Start with data** - `.from(simple({ userId: 1 }))` creates an exchange with a user ID
2. **Enrich from an API** - `.enrich(http(...))` calls an external API and merges the result
3. **Transform** - `.transform(...)` shapes the data into a greeting
4. **Output** - `.to(log())` logs the final result to the console

This pattern (source, transform, destination) is the foundation of every RouteCraft route.

For AI automation, check out the hero example above showing how to send team emails with built-in domain filtering.

## What Can You Build?

### Email Assistant
"Unsubscribe me from promotional emails" → Scans inbox, categorizes, unsubscribes automatically

### Meeting Coordinator  
"Move my meeting with John to 2pm" → Finds the meeting, updates time, notifies attendees

### Travel Planner
"Book me a flight to NYC next Tuesday" → Searches flights, finds best option, presents details

### Restaurant Booking
"Reserve a table for 4 at an Italian place tonight" → Searches restaurants, books reservation

### Expense Tracker
"Add this receipt to my expenses" → Extracts data, categorizes, logs to spreadsheet

### Document Assistant
"Summarize my unread contracts" → Reads PDFs, extracts key terms, prioritizes

## Next steps

{% quick-links %}

{% quick-link title="Introduction" icon="lightbulb" href="/docs/introduction" description="Learn what RouteCraft is and understand the core concepts." /%}
{% quick-link title="AI & MCP Setup" icon="presets" href="/docs/introduction/ai-setup" description="Connect RouteCraft to Claude Desktop or Cursor." /%}
{% quick-link title="Email Assistant" icon="plugins" href="/docs/examples/ai-email-parser" description="Build an AI that can send and manage emails." /%}
{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="System requirements, production builds, and manual setup." /%}

{% /quick-links %}
