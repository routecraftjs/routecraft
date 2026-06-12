---
title: Installation
---

System requirements, manual setup, and production builds. {% .lead %}

## System requirements

- **Bun 1.1.0 or later** - required to run the `craft` CLI. Bun has native TypeScript support so `.ts` capabilities run directly with no build step.
- **Node.js 22.6 or later** - only needed if you embed `@routecraft/routecraft` inside a Node application instead of using the CLI. Node 23.6+ recommended (type stripping is on by default).
- macOS, Windows (including WSL), or Linux.

The CLI is Bun-only. See the [Runtime reference](/docs/reference/runtime) for the rationale and the Node embedding path.

## Create a new project

Scaffold a complete Routecraft project with one command:

{% code-tabs %}
{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft my-app
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest my-app
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest my-app
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft my-app
```
{% /code-tab %}

{% /code-tabs %}

Follow the prompts to configure your project name, package manager, and directory layout. Then:

```bash
cd my-app
bun run start
```

For all flags and options, see [CLI -- create](/docs/reference/cli#create).

## Manual installation

Add Routecraft to an existing project:

{% code-tabs %}
{% code-tab label="bun" language="bash" %}
```bash
bun add @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm install @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add @routecraft/routecraft
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add @routecraft/routecraft
```
{% /code-tab %}

{% /code-tabs %}

Create your first capability:

```ts
// capabilities/my-capability.ts
import { craft, simple, log } from "@routecraft/routecraft";

export default craft()
  .id("my-first-capability")
  .from(simple("Hello, Routecraft!"))
  .to(log());
```

Run it directly with the CLI (requires Bun on the machine):

```bash
bunx craft run capabilities/my-capability.ts
```

The CLI runs on Bun and loads `.ts` files natively, so no `tsc` step is required.

## TypeScript configuration

Routecraft is TypeScript-first. The recommended `tsconfig.json` for a capabilities project:

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
{% code-tab label="bun" language="bash" %}
```bash
bun run build && bun run start
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm run build && npm run start
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm build && pnpm start
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn build && yarn start
```
{% /code-tab %}

{% /code-tabs %}

{% callout type="note" title="Bun is required on the host" %}
The `start` script invokes the local `craft` bin, which runs on Bun (>=1.1.0) regardless of which package manager runs the script. Install Bun on the production host, or follow the [Node embedding path](/docs/advanced/programmatic-invocation) instead.
{% /callout %}

The build step compiles your capabilities to JavaScript. The compiled output in `dist/` is what runs in production with no Node flags and no runtime overhead.

## Embedding Routecraft in your app

To run capabilities from inside an existing Node or Bun application, use `ContextBuilder` directly instead of the CLI. This is the recommended path for Node users.

```ts
import { ContextBuilder, craft, direct, log } from "@routecraft/routecraft";

const route = craft()
  .id("greet")
  .from(direct<{ name: string }>())
  .transform((body) => `Hello, ${body.name}!`)
  .to(log());

const { context, client } = await new ContextBuilder().routes(route).build();
context.start();

await client.sendDirect("greet", { name: "World" });
```

You get full programmatic control: load specific capability files, run a single capability for a batch job, or integrate Routecraft into a larger Express, Next.js, or Fastify server. See the [Programmatic Invocation guide](/docs/advanced/programmatic-invocation) for the full pattern.

---

## Related

{% quick-links %}

{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All CLI commands and options." /%}
{% quick-link title="Project structure" icon="presets" href="/docs/introduction/project-structure" description="Understand the layout of a Routecraft project." /%}

{% /quick-links %}
