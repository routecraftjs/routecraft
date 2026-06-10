# @routecraft/testing

Test utilities for Routecraft capabilities. Runner-agnostic: works with `bun test`, [Vitest](https://vitest.dev), and `node:test` to run capability lifecycles and assert on output, logs, and errors.

## Installation

```bash
# Bun (recommended)
bun add -D @routecraft/testing

# npm / pnpm / yarn
npm install -D @routecraft/testing
pnpm add -D @routecraft/testing
yarn add -D @routecraft/testing
```

Install as a devDependency. Requires `@routecraft/routecraft`. No test runner dependency: bun test, Vitest, and node:test all work out of the box.

## Quick Start

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
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

    // Pass your runner's mock factory for native matcher support
    // (vi.fn for Vitest, mock from bun:test). Omit { fn } to use the
    // built-in runner-agnostic spy and assert via t.logger.info.mock.calls.
    t = await testContext({ fn: vi.fn }).routes(capability).build();
    await t.test();

    expect(t.logger.info).toHaveBeenCalled();
  });
});
```

## API

### `testContext(options?)`

Returns a builder. Call `.routes(...).build()` to get a `TestContext`. Options include `fn` (your runner's mock factory, for native matcher support on `t.logger`) and `routesReadyTimeoutMs`.

### `TestContext`

Wrapper around `CraftContext` with:

- **`ctx`** -- The underlying context.
- **`logger`** -- A runner-agnostic spy logger. Inspect calls via `t.logger.info.mock.calls`, or build the context with your runner's mock factory (`testContext({ fn: vi.fn })` for Vitest, `testContext({ fn: mock })` for bun:test) to use native matchers like `toHaveBeenCalledWith`.
- **`errors`** -- Collected capability errors.
- **`test(options?)`** -- Runs start, waits for capabilities to be ready, optionally delays, drains, then stops. Assert after `await t.test()`.
- **`startAndWaitReady()`** -- Starts the context and waits for all capabilities to be ready without draining. Use with `t.client.send()` to send to a direct endpoint, then call `stop()` when done.
- **`stop()`** / **`drain()`** -- Lifecycle helpers.

### `t.client.send(endpoint, body, headers?)`

Send a message to a direct endpoint and return the result via the `CraftClient`. Use with `startAndWaitReady()`.

```typescript
await t.startAndWaitReady();
const result = await t.client.send('send-email', { to: 'user@example.com' });
await t.stop();
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
