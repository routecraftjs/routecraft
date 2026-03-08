---
title: Getting started
---

## Give AI access, not control

Build automation that agents can use without handing over the keys to your system.

* **Code your automation:** Write TypeScript capabilities that define exactly what an agent can do. Send emails, manage calendars, and trigger workflows entirely from code you own.
* **Two-way agent integration:** Expose your capabilities natively via the Model Context Protocol (MCP) for Claude and Cursor, or route events directly to your own agents in code using `.to(agent())`.
* **Secure by design:** Agents can only execute the specific capabilities you expose. No arbitrary filesystem access. No unchecked shell commands. You maintain absolute authority.

---

## Your first capability

Here's a simple capability that fetches user data and logs a greeting:

```typescript
// capabilities/hello-world.ts
import { log, craft, simple, http } from "@routecraft/routecraft";

export default craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .enrich(
    http<{ userId: number }, { name: string }>({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .to(log());
```

Run it instantly without any setup:

```bash
npx @routecraft/cli run capabilities/hello-world.ts
```

This pattern (source, enrich, transform, destination) is the foundation of every RouteCraft capability.

---

## Play Online

Try RouteCraft in your browser or a cloud environment:

{% quick-links %}

{% quick-link title="Open in GitHub Codespaces" icon="installation" href="https://codespaces.new/routecraftjs/craft-playground" description="Recommended: Full terminal environment with all features." /%}

{% quick-link title="Open on CodeSandbox" icon="installation" href="https://codesandbox.io/p/sandbox/github/routecraftjs/craft-playground" description="Quick browser-based playground." /%}

{% /quick-links %}

**GitHub Codespaces** is recommended since RouteCraft is terminal-first and works best with full shell access.

---

## Create a new project

Scaffold a complete RouteCraft project with all configuration:

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

Start the development server:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
cd my-app
npm run dev
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
cd my-app
yarn dev
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
cd my-app
pnpm run dev
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
cd my-app
bun run dev
```
{% /code-tab %}

{% /code-tabs %}

You should see your capabilities start and log output in your terminal.

---

## What Can You Build?

### Email Assistant
"Unsubscribe me from promotional emails" → Scans inbox, categorizes, unsubscribes automatically

### Meeting Coordinator
"Move my meeting with John to 2pm" → Finds the meeting, updates time, notifies attendees

### Travel Planner
"Book me a flight to NYC next Tuesday" → Searches flights, finds best option, presents details

---

## Next steps

{% quick-links %}

{% quick-link title="Introduction" icon="lightbulb" href="/docs/introduction" description="Learn what RouteCraft is and understand the core concepts." /%}
{% quick-link title="AI & MCP Setup" icon="presets" href="/docs/introduction/ai-setup" description="Connect RouteCraft to Claude Desktop or Cursor." /%}
{% quick-link title="Email Assistant" icon="plugins" href="/docs/examples/ai-email-parser" description="Build an AI that can send and manage emails." /%}
{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="System requirements, production builds, and manual setup." /%}

{% /quick-links %}
