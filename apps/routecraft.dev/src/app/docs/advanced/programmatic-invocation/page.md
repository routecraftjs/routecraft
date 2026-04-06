---
title: Programmatic Invocation
---

Use `CraftClient` to dispatch messages into Routecraft routes from any external code -- CLI tools, HTTP handlers, background jobs, or application logic. {% .lead %}

## How it works

When you build a context with `ContextBuilder`, you get back both the `context` and a `client`. The client's `send()` method dispatches a message to any route that uses a `direct()` source, runs it through the full route pipeline (transforms, destinations, error handling), and returns the result.

This means you can embed Routecraft as a library inside any application. The routes hold your business logic; the surrounding code handles I/O, user interaction, or HTTP plumbing.

```ts
import { ContextBuilder } from '@routecraft/routecraft';

const { context, client } = await new ContextBuilder()
  .routes(myRoutes)
  .build();

await context.start();

// Dispatch from anywhere
const result = await client.send('greet', { name: 'World' });
```

## Build a CLI

Use [Commander](https://github.com/tj/commander.js) (or any CLI framework) to parse arguments, then dispatch into routes via `client.send()`. This gives you full control over help text, subcommands, and shell completion while keeping business logic in Routecraft routes.

```ts
import { Command } from 'commander';
import { direct, craft, noop, ContextBuilder } from '@routecraft/routecraft';

// 1. Define routes using direct() sources
const routes = craft()
  .id('greet')
  .from(direct('greet', {}))
  .transform((body) => `Hello, ${(body as { name: string }).name}!`)
  .to(noop())

  .id('deploy')
  .from(direct('deploy', {}))
  .transform((body) => {
    const { env, dryRun } = body as { env: string; dryRun?: boolean };
    if (dryRun) return `Would deploy to ${env}`;
    return `Deployed to ${env}`;
  })
  .to(noop());

// 2. Build context and get the client
const contextBuilder = new ContextBuilder();
contextBuilder.routes(routes);
const { context, client } = await contextBuilder.build();
context.start();

// 3. Wire Commander commands to client.send()
const program = new Command().name('my-tool').version('1.0.0');

program.hook('postAction', async () => {
  await context.stop();
});

program
  .command('greet')
  .description('Greet someone')
  .argument('<name>', 'Who to greet')
  .action(async (name: string) => {
    const result = await client.send('greet', { name });
    console.log(result);
  });

program
  .command('deploy')
  .description('Deploy the app')
  .requiredOption('-e, --env <env>', 'Target environment')
  .option('-d, --dry-run', 'Preview without deploying')
  .action(async (opts: { env: string; dryRun?: boolean }) => {
    const result = await client.send('deploy', opts);
    console.log(result);
  });

await program.parseAsync();
```

```bash
my-tool greet Alice          # Hello, Alice!
my-tool deploy -e staging -d # Would deploy to staging
my-tool --help               # Commander-generated help
```

### Lifecycle

- Call `context.start()` before dispatching. `direct()` sources are ready immediately since they wait for explicit `send()` calls.
- Stop the context after the CLI command finishes. The `postAction` hook in the example above handles this automatically.
- For error handling, wrap `client.send()` in a try/catch and set `process.exitCode` as needed.

## Embed in a web framework

The same `direct()` + `CraftClient` pattern works inside HTTP frameworks. Start the context once when the server boots, then call `client.send()` from request handlers.

### Next.js API route

```ts
// lib/routecraft.ts -- shared singleton
import { ContextBuilder, direct, craft, noop } from '@routecraft/routecraft';

const routes = craft()
  .id('greet')
  .from(direct('greet', {}))
  .transform((body) => `Hello, ${(body as { name: string }).name}!`)
  .to(noop());

const contextBuilder = new ContextBuilder();
contextBuilder.routes(routes);
const { context, client } = await contextBuilder.build();
await context.start();

export { client };
```

```ts
// app/api/greet/route.ts
import { client } from '@/lib/routecraft';

export async function POST(request: Request) {
  const body = await request.json();
  const result = await client.send('greet', body);
  return Response.json({ message: result });
}
```

### Express

```ts
import express from 'express';
import { ContextBuilder, direct, craft, noop } from '@routecraft/routecraft';

const routes = craft()
  .id('greet')
  .from(direct('greet', {}))
  .transform((body) => `Hello, ${(body as { name: string }).name}!`)
  .to(noop());

const contextBuilder = new ContextBuilder();
contextBuilder.routes(routes);
const { context, client } = await contextBuilder.build();
await context.start();

const app = express();
app.use(express.json());

app.post('/greet', async (req, res) => {
  const result = await client.send('greet', req.body);
  res.json({ message: result });
});

app.listen(3000);
```

### Lifecycle tips

- Start the context once at boot, not per-request.
- For graceful shutdown, call `context.stop()` in your server's shutdown handler (e.g., `process.on('SIGTERM', ...)`).
- `client.send()` throws a `RoutecraftError` (`RC5004`) if the endpoint does not exist. Return a 404 or appropriate status in your error handler.

---

## Related

{% quick-links %}

{% quick-link title="direct adapter" icon="presets" href="/docs/reference/adapters#direct" description="The direct() adapter that powers programmatic dispatch." /%}
{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="craft run and other CLI commands." /%}
{% quick-link title="Configuration" icon="plugins" href="/docs/reference/configuration" description="ContextBuilder options and craftConfig." /%}

{% /quick-links %}
