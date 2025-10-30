---
title: Installation
---

Install via the CLI or manually add packages. {% .lead %}

## Play Online

If you want to try RouteCraft in your browser without installing anything, open our examples:

{% quick-links %}

{% quick-link title="Open on CodeSandbox" icon="installation" href="https://codesandbox.io/p/sandbox/github/routecraftjs/craft-playground?file=%2Froutes%2Fhello-world.route.ts" description="Play around with RouteCraft in your browser." /%}

{% /quick-links %}

## System requirements

- [Node.js 22](https://nodejs.org/en) or later.
- macOS, Windows (including WSL), or Linux.

## Create with the CLI

Create a new RouteCraft project:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest <project-name>
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft <project-name>
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest <project-name>
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft <project-name>
```
{% /code-tab %}

{% /code-tabs %}

Open your project folder in Visual Studio Code:

```bash
code <project-name>
```

### Start the development server

Use the project scripts created by the initializer:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm run dev
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn dev
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm dev
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bun run dev
```
{% /code-tab %}

{% /code-tabs %}

You should see your routes start and log output in your terminal.

### Production (optional)

Build and start the app:

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

Add the core library:

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

**Note:** The CLI `run` command executes only JavaScript route files (.mjs/.js/.cjs). If you author routes in TypeScript, compile them to JavaScript before running.

Run it with the CLI (recommended), or execute within your own Node app using `CraftContext`.