import {
  TestContext,
  TestContextBuilder,
  testContext,
} from "./test-context.ts";
import type { EventName } from "@routecraft/routecraft";

/** A started context and the port its server actually bound. */
export interface BootedServer {
  ctx: TestContext;
  port: number;
}

/**
 * Start a context whose server binds an OS-chosen port, and hand back both.
 *
 * Every http and ops suite needs the same three things and was writing them
 * out per file: subscribe to `server:listening`, keep the port it reports,
 * and assert something was actually bound. That last part matters, because a
 * port left at 0 turns every later request into a confusing connection error
 * rather than a failed setup.
 *
 * The builder arrives as a callback rather than as options, so each test
 * keeps its own routes, config, auth and extra subscriptions instead of the
 * helper growing a parameter per caller.
 *
 * `server:listening` is also how an operator learns the port, so a test that
 * reads it is exercising the same path rather than a private accessor.
 */
export async function bootServer(
  build: (builder: TestContextBuilder) => TestContextBuilder,
): Promise<BootedServer> {
  let port = 0;
  const builder = testContext().on(
    "server:listening" as EventName,
    ((payload: { details: unknown }) => {
      port = (payload.details as { port: number }).port;
    }) as Parameters<TestContextBuilder["on"]>[1],
  );
  const ctx = await build(builder).build();
  await ctx.startAndWaitReady();
  if (port === 0) {
    // Thrown rather than asserted: this package ships to both runtimes and
    // must not depend on a test runner's globals. A port left at 0 also has
    // to fail here, because every later request would otherwise present as a
    // connection error rather than as the setup that never bound.
    throw new Error(
      "No server reported a port: nothing emitted server:listening, so no listener bound.",
    );
  }
  return { ctx, port };
}

/**
 * Poll until a predicate holds, or give up.
 *
 * For state that settles on the server's own timeline (a generator's
 * `finally`, an event handler) rather than on the promise the test awaited.
 * Returns whether it held, so a caller can assert on that rather than on a
 * bare timeout.
 */
export async function waitFor(
  predicate: () => boolean,
  timeout = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

/**
 * One `read()` bounded by a deadline, resolving `undefined` when the deadline
 * wins.
 *
 * A `while (Date.now() < deadline)` loop checks its bound between reads and
 * never during one, so a stream that simply goes quiet parks in `read()` until
 * the runner's own timeout fires. That reports as the whole file timing out
 * rather than the one assertion that failed.
 */
type ReadStep = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

async function readBefore(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<ReadStep | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let expire: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    reader.read(),
    new Promise<undefined>((resolve) => {
      expire = setTimeout(() => resolve(undefined), remaining);
    }),
  ]).finally(() => clearTimeout(expire));
}

/**
 * Read a response body until it contains `marker`, then stop and return
 * everything read so far.
 *
 * A streaming assertion cannot await the whole body, and chunk boundaries are
 * the runtime's business, so a test that reads exactly one chunk is asserting
 * something the runtime never promised.
 */
export async function readUntil(
  response: Response,
  marker: string,
  timeout = 5000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeout;
  let seen = "";
  try {
    while (!seen.includes(marker)) {
      const step = await readBefore(reader, deadline);
      if (step === undefined || step.done) break;
      seen += decoder.decode(step.value, { stream: true });
    }
    return seen;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Drain a response body until the server closes it, answering whether it
 * closed within `timeout`.
 *
 * The assertion a test makes about a stream the server ends on its own, such
 * as one closed by shutdown or by a credential expiring. Answering `false`
 * rather than throwing keeps the failure on the test's own `expect`.
 */
export async function readUntilClosed(
  response: Response,
  timeout = 5000,
): Promise<boolean> {
  const reader = response.body!.getReader();
  const deadline = Date.now() + timeout;
  try {
    for (;;) {
      const step = await readBefore(reader, deadline);
      if (step === undefined) return false;
      if (step.done) return true;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
