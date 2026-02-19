# @routecraft/testing

Test utilities for RouteCraft routes. Use with [Vitest](https://vitest.dev) to run route lifecycles and assert on logs and errors.

## Installation

```bash
npm install -D @routecraft/testing
```

or

```bash
pnpm add -D @routecraft/testing
```

Install as a **devDependency** and ensure `vitest` (>=4.0.0) and `@routecraft/routecraft` are available.

## Quick Start

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";

describe("my route", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  it("runs and logs", async () => {
    const route = craft().id("example").from(simple("hello")).to(log());

    t = await testContext().routes(route).build();
    await t.test();

    expect(t.logger.info).toHaveBeenCalled();
  });
});
```

## API

- **`testContext()`** — Returns a builder. Call `.routes(...).build()` to get a `TestContext`.
- **`TestContext`** — Wrapper around `CraftContext` with:
  - **`ctx`** — The underlying context.
  - **`logger`** — A spy logger (Vitest `vi.fn()` methods) for asserting on log calls.
  - **`errors`** — Collected route errors.
  - **`test()`** — Runs start → wait for routes ready → drain → stop. Assert after `await t.test()`.
  - **`stop()`** / **`drain()`** — Lifecycle helpers.
- **`TestContextOptions`** — Options (e.g. `routesReadyTimeoutMs`).
- **`SpyLogger`** — Type for the spy logger on `t.logger`.

## Documentation

For testing patterns and examples, see [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
