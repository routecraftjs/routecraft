---
title: Testing
---

Test your custom RouteCraft routes with fast unit tests and optional E2E runs. {% .lead %}

## Quick start

```ts
import { describe, it, expect, vi } from "vitest";
import { context } from "@routecraft/routecraft";
import helloRoute from "../routes/hello-world.route";

describe("hello route", () => {
  it("emits and logs", async () => {
    const logSpy = vi.spyOn(console, "log");

    const ctx = context().routes(helloRoute).build();
    const execution = ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await ctx.stop();
    await execution;

    expect(logSpy).toHaveBeenCalled();
  });
});
```

## Vitest configuration

For a new project, use a single `vitest.config.mjs` at the project root:

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
```

## Route lifecycle in tests

Build a `CraftContext`, start it, give it time to run, then stop and await completion:

```ts
import { context } from "@routecraft/routecraft";
import routes from "../routes/hello-world.route"; // your route builder export

const testContext = context().routes(routes).build();
const execution = testContext.start();
await new Promise((r) => setTimeout(r, 100));
await testContext.stop();
await execution;
```

Checklist:

- Start with `const execution = ctx.start()`; later `await ctx.stop()` and `await execution`.
- Keep waits small (50–200ms) for single-shot routes; use timers/mocks for long-running routes.
- Restore mocks in `beforeEach/afterEach`.

## Common testing patterns

### Using the spy adapter

The `spy()` adapter is purpose-built for testing. It records all interactions and provides convenient assertion methods:

```ts
import { spy } from "@routecraft/routecraft";

const spyAdapter = spy();

// Available properties:
spyAdapter.received         // Array of exchanges received
spyAdapter.calls.send       // Number of send() calls
spyAdapter.calls.process    // Number of process() calls (if used as processor)
spyAdapter.calls.enrich     // Number of enrich() calls (if used as enricher)

// Methods:
spyAdapter.reset()          // Clear all recorded data
spyAdapter.lastReceived()   // Get the most recent exchange
spyAdapter.receivedBodies() // Get array of just the body values
```

### Spy on destinations to assert outputs

```ts
import { craft, simple, spy, context } from "@routecraft/routecraft";
import { expect } from "vitest";

const spyAdapter = spy();

const route = craft().id("out").from(simple("payload")).to(spyAdapter);
const ctx = context().routes(route).build();
await ctx.start();

expect(spyAdapter.received).toHaveLength(1);
expect(spyAdapter.received[0].body).toBe("payload");
expect(spyAdapter.calls.send).toBe(1);
```

### Spy on console logs

For routes that use `.to(log())`, spy on `console.log` to verify logging behavior:

```ts
import { craft, simple, log, context } from "@routecraft/routecraft";
import { vi, expect } from "vitest";

test('logs messages correctly', async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  
  const route = craft()
    .id("log-test")
    .from(simple("Hello, World!"))
    .to(log());
    
  const ctx = context().routes(route).build();
  await ctx.start();
  
  expect(logSpy).toHaveBeenCalled();
  const loggedMessage = logSpy.mock.calls[0][0];
  expect(loggedMessage).toContain("Hello, World!");
  
  logSpy.mockRestore();
});
```

**Tip:** Use `spy()` adapter instead of `log()` when you need more control over assertions.

Mock child logger for timer-heavy tests:

```ts
import { vi } from "vitest";
import { logger } from "@routecraft/routecraft";

const childLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info", child: vi.fn().mockReturnThis() } as any;
vi.spyOn(logger, "child").mockReturnValue(childLogger);
```

Filter logs by route id (from `LogAdapter` headers):

```ts
const logsForRoute = calls.filter(
  (arg) => typeof arg === "object" && arg != null && "headers" in arg && (arg as any).headers?.["routecraft.route"] === "channel-adapter-1",
);
```

### Test custom sources that await the final exchange

```ts
import { craft, context, spy } from "@routecraft/routecraft";

let observed: any;
const spyAdapter = spy();

const route = craft()
  .id("return-final")
  .from({
      subscribe: async (_ctx, handler, controller) => {
        try {
          observed = await handler("hello");
        } finally {
          controller.abort();
        }
      },
    },
  ])
  .transform((body: string) => body.toUpperCase())
  .to(spyAdapter)
  .transform((body: string) => `${body}!`);

const ctx = context().routes(route).build();
await ctx.start();

expect(observed.body).toBe("HELLO!");
expect(spyAdapter.received[0].body).toBe("HELLO!");
```

### Timers and long‑running routes

Option A: small real waits (simple):

```ts
const execution = ctx.start();
await new Promise((r) => setTimeout(r, 150));
await ctx.stop();
await execution;
```

## Assertion patterns

### Spy adapter assertions

```ts
// Basic assertions
expect(spyAdapter.received).toHaveLength(3);
expect(spyAdapter.calls.send).toBe(3);

// Body content validation
expect(spyAdapter.receivedBodies()).toEqual(['msg1', 'msg2', 'msg3']);
expect(spyAdapter.lastReceived().body).toBe('final-message');

// Header validation
expect(spyAdapter.received[0].headers['routecraft.route']).toBe('my-route');

// Complex object validation
const lastExchange = spyAdapter.lastReceived();
expect(lastExchange.body).toHaveProperty("original");
expect(lastExchange.body).toHaveProperty("additional");
```

### Using spy as processor or enricher

```ts
// Test processing behavior
const processSpy = spy();
const route = craft()
  .id("test-process")
  .from(simple("input"))
  .process(processSpy) // Use spy as processor
  .to(spy());

await ctx.start();
expect(processSpy.calls.process).toBe(1);
expect(processSpy.received[0].body).toBe("input");

// Test enrichment behavior  
const enrichSpy = spy();
const route2 = craft()
  .id("test-enrich")
  .from(simple({ name: "John" }))
  .enrich(enrichSpy) // Use spy as enricher
  .to(spy());

await ctx.start();
expect(enrichSpy.calls.enrich).toBe(1);
```

### Route validation

```ts
// Ensure a route id is set after build
const r = craft().id("x").from(simple("y")).to(spy());
expect(r.build()[0].id).toBe("x");
```

### Multiple spies in one route

```ts
const transformSpy = spy();
const destinationSpy = spy();

const route = craft()
  .id("multi-spy")
  .from(simple("start"))
  .process(transformSpy)
  .to(destinationSpy);

await ctx.start();

// Verify the pipeline
expect(transformSpy.calls.process).toBe(1);
expect(destinationSpy.calls.send).toBe(1);
expect(transformSpy.received[0].body).toBe("start");
expect(destinationSpy.received[0].body).toBe("start"); // Assuming spy processes pass-through
```

### Headers and correlation

```ts
const captured: string[] = [];
// inside a .process/.tap
captured.push(exchange.headers["routecraft.correlation_id"] as string);
expect(new Set(captured).size).toBe(1);
```

## Run route files

Use the CLI to run compiled route files/folders as an integration check:

```bash
pnpm craft run ./examples/hello-world.mjs
```

## Troubleshooting

- Hanging tests: ensure you `await ctx.stop()` and then `await execution`.
- Flaky timers: prefer fake timers or increase the wait to 100–200ms.
- No logs captured: ensure your route includes `.to(log())` or you spy on the child logger.
