# @routecraft/testing

Test utilities for RouteCraft capabilities. Use with [Vitest](https://vitest.dev) to run capability lifecycles and assert on output, logs, and errors.

## Installation

```bash
npm install -D @routecraft/testing
```

or

```bash
pnpm add -D @routecraft/testing
```

Install as a devDependency. Requires `vitest` (>=4.0.0) and `@routecraft/routecraft`.

## Quick Start

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { testContext, type TestContext } from '@routecraft/testing';
import { craft, simple, log } from '@routecraft/routecraft';

describe('send-email capability', () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
  });

  it('processes and logs the exchange', async () => {
    const capability = craft()
      .id('send-email')
      .from(simple({ to: 'user@example.com', subject: 'Hello' }))
      .to(log());

    t = await testContext().routes(capability).build();
    await t.test();

    expect(t.logger.info).toHaveBeenCalled();
  });
});
```

## API

### `testContext()`

Returns a builder. Call `.routes(...).build()` to get a `TestContext`.

### `TestContext`

Wrapper around `CraftContext` with:

- **`ctx`** -- The underlying context.
- **`logger`** -- A spy logger (Vitest `vi.fn()` methods) for asserting on log calls.
- **`errors`** -- Collected capability errors.
- **`test(options?)`** -- Runs start, waits for capabilities to be ready, optionally delays, drains, then stops. Assert after `await t.test()`.
- **`startAndWaitReady()`** -- Starts the context and waits for all capabilities to be ready without draining. Use with `invoke()` to call a capability by ID, then call `stop()` when done.
- **`stop()`** / **`drain()`** -- Lifecycle helpers.

### `invoke(ctx, routeIdOrDestination, body, headers?)`

Invoke a capability by ID or send to a `Destination` instance. Returns the result.

```typescript
const result = await invoke(t.ctx, 'send-email', { to: 'user@example.com' });
```

### Options

- **`TestContextOptions`** -- Builder options, e.g. `routesReadyTimeoutMs`.
- **`TestOptions`** -- Options for `test()`, e.g. `delayBeforeDrainMs` -- useful for timer-based capabilities so at least one message is processed before drain.

```typescript
// Wait 50ms after ready before draining (e.g. for a timer with intervalMs: 50)
await t.test({ delayBeforeDrainMs: 50 });
```

## Documentation

For testing patterns and examples, see [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
