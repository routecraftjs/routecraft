---
title: Testing
---

Test your capabilities with fast unit tests and optional E2E runs. {% .lead %}

## Quick start

Use `testContext()` to build a test context and `t.test()` to run the full lifecycle (start, wait for routes ready, drain, stop). Assert after `await t.test()`:

```ts
import { describe, it, expect, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import helloRoute from "../capabilities/hello-world";

describe("hello capability", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  it("emits and logs", async () => {
    t = await testContext().routes(helloRoute).build();
    await t.test();

    expect(t.logger.info).toHaveBeenCalled();
  });
});
```

**Tip:** `t.logger` is a spy (vi.fn() methods). Use `expect(t.logger.info).toHaveBeenCalled()` or inspect `t.logger.info.mock.calls` for log assertions.

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

Use `testContext()` and `t.test()` for the recommended flow. `t.test()` runs start → wait for all routes ready → drain → stop, so you don't need manual timeouts for direct/simple routes:

```ts
import { testContext, type TestContext } from "@routecraft/testing";
import routes from "../capabilities/hello-world"; // your capability export

const t = await testContext().routes(routes).build();
await t.test();
// Assert here: mocks, t.errors, t.ctx.getStore(), etc.
```

Checklist:

- Prefer `await t.test()` for full lifecycle; assert after it returns.
- Use `t.ctx` when you need the raw context (e.g. `t.ctx.start()`, `t.ctx.getStore()`).
- Use `t.logger` to assert on log calls (e.g. `expect(t.logger.info).toHaveBeenCalled()`).
- For custom timing (e.g. timer routes), use `t.ctx.start()` and `t.ctx.stop()` manually.
- Restore mocks in `beforeEach/afterEach`.

## Mocking external adapters

When your route uses an adapter that talks to an external system -- `mail()`, `http()`, `mcp()`, etc. -- you want to test your logic, not re-test the adapter. Two things you should **not** do:

- Mock the adapter's underlying library (`imapflow`, `nodemailer`, `globalThis.fetch`). This couples your tests to our implementation choices; the day we swap a library, your tests break even though nothing in the public contract changed.
- Restructure the route to inject test adapters. The route you run in production should be the route you test.

Use `mockAdapter()` and `testContext().override()` instead. You import the factory (`mail`, `http`, ...), describe how it should behave in the test, and register the mock on the test context. The route stays unchanged.

```ts
import { mail } from "@routecraft/routecraft";
import { mockAdapter, testContext, type TestContext } from "@routecraft/testing";
import route from "../capabilities/mail-triage";

const mailMock = mockAdapter(mail, {
  // Source role: feeds the .from(mail(...)) call site
  source: [
    { uid: 1, from: "friend@co.com", subject: "lunch?", ... },
    { uid: 2, from: "spam@x.com",    subject: "URGENT BUY NOW", ... },
  ],
  // Destination role: stands in for every .to(mail(...)) and .enrich(mail(...))
  // call in the route. Use `args` (what was passed to mail()) to discriminate.
  send: async (exchange, { args }) => {
    if (args[0]?.action === "move") return { moved: true };
    return { messageId: "<fake>" };
  },
});

let t: TestContext;
afterEach(async () => { if (t) await t.stop(); });

it("moves spam and replies to friends", async () => {
  t = await testContext().override(mailMock).routes(route).build();
  await t.test();

  expect(mailMock.calls.source).toHaveLength(1);
  expect(mailMock.calls.send).toHaveLength(2);
  expect(mailMock.calls.send[0].args[0]).toMatchObject({ action: "move" });
  expect(mailMock.calls.send[1].exchange.body.to).toBe("friend@co.com");
});
```

### When to use what

| You want to... | Use |
|---|---|
| Test a route that calls an external system (IMAP/SMTP, HTTP, MCP) | `mockAdapter(factory, { source, send })` + `.override()` |
| Test that an in-process destination was invoked | `spy()` (see below) |
| Drive a route's input manually from the test | `simple(value)` or a `callableSource` |
| Assert on logger calls | `t.logger.info` / `t.logger.warn` (vi spies) |

### Anatomy of a mock

- **`source`** -- an array of fixtures, a (sync or async) iterable, or `(args) => iterable`. Each item is delivered to `.from(factory(...))` as one exchange. For polling sources this models one poll cycle.
- **`send`** -- `(exchange, { args }) => result`. Called for every `.to(factory(...))`, `.enrich(factory(...))`, and `.tap(factory(...))` in the route. Accepts a `vi.fn()` too, so `mockResolvedValueOnce` / `mockRejectedValueOnce` chains work as expected.
- **`args`** -- whatever the route passed to the factory at that call site. Use it to discriminate when the same factory is used in multiple positions (e.g. `mail("INBOX")` as source vs `mail({ action: "move" })` as destination).

### Inspecting recorded calls

```ts
mailMock.calls.source   // [{ args, yielded }]   -- per subscribe call
mailMock.calls.send     // [{ args, exchange, result }]
                         //   exchange = { id, body, headers } snapshot
                         //   result   = whatever the send handler returned
```

Failed sends (where the handler throws) are still recorded; `result` stays `undefined` and the error surfaces through the route the same way a real adapter failure would. Check `t.errors` afterwards.

### What mocks do not preserve

A mock stands in for the adapter's `send` / `subscribe`, nothing more. These side effects of the real adapter are **not** reproduced:

- **Metadata headers from `getMetadata`.** Real adapters like `http()` stamp headers on the exchange (status, response headers, etc.) via their `getMetadata` method. The override path skips this, since mock results are typically primitives with no adapter-specific shape.
- **Tracking ids and correlation data** that specific adapters attach to exchanges.
- **Timing and I/O side effects** (connection pooling, retries, backoff) that the real adapter performs around the call.

If your route asserts on something the real adapter would have added, set it yourself from the `send` handler before returning:

```ts
const httpMock = mockAdapter(http, {
  send: async (exchange) => {
    exchange.headers["http.status"] = 200;
    return { status: 200, headers: {}, body: { ok: true }, url: "x" };
  },
});
```

### Same factory used multiple times

One mock covers every call site of the factory. Discriminate inside `send` using `args`, or chain `vi.fn()` implementations for ordered responses:

```ts
const httpMock = mockAdapter(http, {
  send: vi.fn()
    .mockResolvedValueOnce({ status: 200, body: { ok: true } })
    .mockRejectedValueOnce(new Error("429 Too Many Requests"))
    .mockResolvedValue({ status: 200, body: { ok: true } }),
});
```

### What you can pass as the target

`mockAdapter(target, behavior)` accepts two kinds of target:

- **A factory function** -- e.g. `mockAdapter(mail, ...)`, `mockAdapter(http, ...)`. Matches every adapter instance that factory produced. Requires the factory to stamp its adapters via `tagAdapter()` internally. The first-party factories `mail()`, `http()`, and `mcp()` do this today.
- **An adapter class** -- e.g. `mockAdapter(SomeAdapterClass, ...)`. Matches any adapter whose `constructor === target`. Works for every adapter, first-party or third-party, without opt-in tagging. Useful when a third-party adapter exports its class but not a tagged factory, or when you want to mock a specific role of a multi-role factory.

The factory form is nicer when the factory covers a single role. The class form is required when the factory has no tag or when you want to target one specific role of a multi-role factory. Both forms can be mixed on the same `testContext()`.

In-process adapters like `direct()`, `simple()`, `log()`, and `noop()` do not talk to an external system. Use `spy()` or drive inputs directly for those.

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
import { testContext } from "@routecraft/testing";
import { craft, simple, spy } from "@routecraft/routecraft";
import { expect } from "vitest";

const spyAdapter = spy();

const route = craft().id("out").from(simple("payload")).to(spyAdapter);
const t = await testContext().routes(route).build();
await t.test();

expect(spyAdapter.received).toHaveLength(1);
expect(spyAdapter.received[0].body).toBe("payload");
expect(spyAdapter.calls.send).toBe(1);
```

### Assert on log output

`testContext().build()` returns a test context whose `t.logger` is a spy. Use it to assert on pino log calls (e.g. from `.to(log())` or adapter logging):

```ts
import { testContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";
import { expect, vi } from "vitest";

test('logs messages correctly', async () => {
  const route = craft()
    .id("log-test")
    .from(simple("Hello, World!"))
    .to(log());

  const t = await testContext().routes(route).build();
  await t.test();

  expect(t.logger.info).toHaveBeenCalled();
  const loggedMessage = (t.logger.info as ReturnType<typeof vi.fn>).mock.calls[0][1];
  expect(loggedMessage).toContain("Hello, World!");
});
```

**Tip:** Use `spy()` adapter instead of `log()` when you need more control over assertions.

Filter logs by route id (from `LogAdapter` headers):

```ts
const infoCalls = (t.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const logsForRoute = infoCalls.filter(
  (arg) => typeof arg === "object" && arg != null && "headers" in arg && (arg as any).headers?.["routecraft.route"] === "channel-adapter-1",
);
```

### Test custom sources that await the final exchange

```ts
import { testContext } from "@routecraft/testing";
import { craft, spy } from "@routecraft/routecraft";

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
  })
  .transform((body: string) => body.toUpperCase())
  .to(spyAdapter)
  .transform((body: string) => `${body}!`);

const t = await testContext().routes(route).build();
await t.test();

expect(observed.body).toBe("HELLO!");
expect(spyAdapter.received[0].body).toBe("HELLO!");
```

### Timers and long-running routes

Use `.routesReadyTimeout(ms)` to give timer or slow-starting routes more time to become ready before `t.test()` proceeds:

```ts
const t = await testContext()
  .routesReadyTimeout(500)
  .routes(timerRoute)
  .build();
await t.test();
```

For cases where you need precise control over the run window, drive the lifecycle manually:

```ts
const t = await testContext().routes(timerRoute).build();
const execution = t.ctx.start();
await new Promise((r) => setTimeout(r, 150));
await t.ctx.stop();
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

const t = await testContext().routes(route).build();
await t.test();
expect(processSpy.calls.process).toBe(1);
expect(processSpy.received[0].body).toBe("input");

// Test enrichment behavior  
const enrichSpy = spy();
const route2 = craft()
  .id("test-enrich")
  .from(simple({ name: "John" }))
  .enrich(enrichSpy) // Use spy as enricher
  .to(spy());

const t2 = await testContext().routes(route2).build();
await t2.test();
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

const t = await testContext().routes(route).build();
await t.test();

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

## Run capability files

Use the CLI to run compiled capability files/folders as an integration check:

```bash
pnpm craft run ./examples/dist/hello-world.js
```

## Troubleshooting

- Hanging tests: use `await t.test()` for standard flows, or ensure you `await t.ctx.stop()` and then `await execution` when driving lifecycle manually.
- Flaky timers: prefer fake timers or increase the wait to 100–200ms.
- No logs captured: ensure your route includes `.to(log())` and assert on `t.logger.info` (or `t.logger.warn` / `t.logger.debug`) after `await t.test()`.
- Errors in tests: check `t.errors` after `await t.test()`; Routecraft errors are collected automatically.

---

## Related

{% quick-links %}

{% quick-link title="Errors reference" icon="warning" href="/docs/reference/errors" description="RC error codes -- useful when asserting on t.errors in tests." /%}

{% /quick-links %}
