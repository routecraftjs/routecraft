---
title: Runtime
---

The `craft` CLI runs on Bun. Routecraft itself is also a library, so Node users embed it programmatically. {% .lead %}

## CLI runtime: Bun

The `craft` bin ships with a `#!/usr/bin/env bun` shebang. `bunx craft`, `bun run start`, and `craft` all execute under Bun natively. There is no Node fallback and no tsx bridge.

### Version floor

Routecraft requires **Bun 1.1.0 or later**. The CLI checks `process.versions.bun` at startup and exits with a clear error message if Bun is missing or below the floor.

```
$ craft run index.ts
[routecraft] Bun 1.0.0 is not supported. Routecraft requires Bun 1.1.0 or
later. Upgrade Bun: https://bun.com/docs/installation.
```

If Bun is not installed at all, the OS resolves `env bun` and reports `bun: command not found`. The CLI cannot start without Bun.

### Why Bun-only

Bun has native TypeScript support, which means the CLI can load `.ts` capability files directly with no `tsc` step and no tsx loader bridge. Bun also provides built-in drivers (`Bun.sql`, `Bun.s3`, `bun:sqlite`, native YAML and TOML parsers) that adapters can use without pulling in extra dependencies. Standardising on Bun for the CLI lets every adapter rely on those primitives and keeps the install footprint small.

## Embedding in Node

Users who want to run Routecraft inside a Node application embed the library directly instead of going through the CLI. The library itself works on **Node 22.6 or later** (for runtime type stripping) and is recommended on **Node 23.6 or later** where stripping is on by default.

A few features of the library are Bun-only because they depend on Bun built-ins that have no Node equivalent:

- **`telemetry()` SQLite sink.** Backed by `bun:sqlite`. Under Node, the sink disables itself with a warn log and only the OTel external path runs. Configure `telemetry({ tracerProvider })` with an OTLP exporter (Datadog, Honeycomb, Better Stack, etc.) for production telemetry under either runtime.

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
await context.stop();
```

See [Programmatic Invocation](/docs/advanced/programmatic-invocation) for the full embedding guide, including Express, Next.js, and Commander integrations.

## Choosing a runtime

| Use case | Runtime | How to run |
| --- | --- | --- |
| Running a project scaffolded by `create-routecraft` | Bun | `bun run start` |
| Quick `.ts` script | Bun | `bunx craft run capabilities/my-route.ts` |
| Embedded inside an existing Node application | Node 22.6+ | Import `@routecraft/routecraft`; do not invoke the CLI |
| Embedded inside a Bun application | Bun | Import `@routecraft/routecraft`; do not invoke the CLI |

---

## Related

{% quick-links %}

{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="craft commands and options." /%}
{% quick-link title="Programmatic Invocation" icon="plugins" href="/docs/advanced/programmatic-invocation" description="Embed Routecraft inside Node, Express, or Next.js." /%}
{% quick-link title="Installation" icon="installation" href="/docs/introduction/installation" description="System requirements and project setup." /%}

{% /quick-links %}
