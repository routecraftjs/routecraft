---
title: Getting started
---

Get up and running with RouteCraft in 60 seconds. {% .lead %}

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

The starter project includes a hello world route at `routes/hello-world.route.ts` (shown above). It demonstrates the core flow:

1. **Start with data** - `.from(simple({ userId: 1 }))` creates an exchange with a user ID
2. **Enrich from an API** - `.enrich(fetch(...))` calls an external API and merges the result
3. **Transform** - `.transform(...)` shapes the data into a greeting
4. **Output** - `.to(log())` logs the final result to the console

This pattern (source, transform, destination) is the foundation of every RouteCraft route.

## Next steps

{% quick-links %}

{% quick-link title="Introduction" icon="lightbulb" href="/docs/introduction" description="Learn what RouteCraft is and understand the core concepts." /%}
{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="System requirements, production builds, and manual setup." /%}
{% quick-link title="Routes" icon="plugins" href="/docs/introduction/routes" description="Author small, focused routes using the DSL." /%}
{% quick-link title="Operations" icon="presets" href="/docs/reference/operations" description="All the steps you can use in your routes." /%}

{% /quick-links %}
