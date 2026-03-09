---
title: Installation
---

System requirements, manual setup, and production builds. {% .lead %}

## System requirements

- **Node.js 22.6 or later** - required for the `--experimental-strip-types` flag, which lets you run `.ts` files directly without a build step.
- **Node.js 23.6 or later** - recommended. TypeScript stripping is stable and enabled by default; no flags needed.
- macOS, Windows (including WSL), or Linux.

## Create a new project

Scaffold a complete RouteCraft project with one command:

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

Follow the prompts to configure your project name, package manager, and directory layout. Then:

```bash
cd my-app
npm run start
```

For all flags and options, see [CLI -- create](/docs/reference/cli#create).

## Manual installation

Add RouteCraft to an existing project:

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

Create your first capability:

```ts
// capabilities/my-capability.ts
import { craft, simple, log } from "@routecraft/routecraft";

export default craft()
  .id("my-first-capability")
  .from(simple("Hello, RouteCraft!"))
  .to(log());
```

Run it directly with the CLI:

```bash
npx @routecraft/cli run capabilities/my-capability.ts
```

On Node 22.6+, the CLI strips TypeScript at runtime with no `tsc` step required. On Node 23.6+ this happens automatically without any flags.

## TypeScript configuration

RouteCraft is TypeScript-first. The recommended `tsconfig.json` for a capabilities project:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["capabilities/**/*.ts", "src/**/*.ts"]
}
```

You only need to compile (`tsc`) when building for production. During development, the CLI runs your `.ts` files directly.

## Production builds

Build and start for production:

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

The build step compiles your capabilities to JavaScript. The compiled output in `dist/` is what runs in production with no Node flags and no runtime overhead.

## Embedding RouteCraft in your app

If you're running capabilities from within an existing Node application instead of using the CLI, use `CraftContext` directly:

```ts
import { CraftContext } from "@routecraft/routecraft";

const ctx = new CraftContext();
await ctx.load("capabilities/");
await ctx.start();
```

This gives you full programmatic control: load specific capability files, run a single capability for a batch job, or integrate RouteCraft into a larger Express or Fastify server.

---

## Related

{% quick-links %}

{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All CLI commands and options." /%}
{% quick-link title="Project structure" icon="presets" href="/docs/introduction/project-structure" description="Understand the layout of a RouteCraft project." /%}

{% /quick-links %}
