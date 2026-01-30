---
title: Installation
---

System requirements, alternative setup methods, and production builds. {% .lead %}

## System requirements

- [Node.js 22](https://nodejs.org/en) or later.
- macOS, Windows (including WSL), or Linux.

## Production builds

Build and start the app for production:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm run build && npm run start
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn build && yarn start
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm build && pnpm start
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bun run build && bun run start
```
{% /code-tab %}

{% /code-tabs %}

## Manual installation

If you prefer to add RouteCraft to an existing project instead of using the CLI:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm install @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bun add @routecraft/routecraft
```
{% /code-tab %}

{% /code-tabs %}

Create your first route:

```ts
// routes/my-route.ts
import { craft, simple, log } from "@routecraft/routecraft";

export default craft()
  .id("my-first-route")
  .from(simple("Hello, RouteCraft!"))
  .to(log());
```

Run it with the CLI (recommended), or execute within your own Node app using `CraftContext`.

## TypeScript note

The CLI `run` command executes only JavaScript route files (`.mjs`, `.js`, `.cjs`). If you author routes in TypeScript, compile them to JavaScript before running.
