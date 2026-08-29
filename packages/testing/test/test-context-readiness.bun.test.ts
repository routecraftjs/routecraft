import { afterEach, describe, expect, test } from "bun:test";
import {
  craft,
  noop,
  simple,
  type Source,
  type Subscription,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

/**
 * The smallest Standard Schema that accepts anything, so a multi-source route
 * can declare the shared input contract `.from()` requires without this
 * package taking on a validation library for two tests.
 */
const anything = {
  "~standard": {
    version: 1 as const,
    vendor: "routecraft-testing",
    validate: (value: unknown) => ({ value }),
  },
};

/**
 * A source that never signals readiness on its own, standing in for one whose
 * driver import has not resolved yet (the cron adapter readies only once
 * `croner` loads). A route pairing this with `simple` reports started only
 * once this one is released, which is the window every case below exercises.
 */
class LateSource implements Source<unknown> {
  readonly adapterId = "test.adapter.late";
  private release?: () => void;

  async subscribe(sub: Subscription<unknown>): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = () => {
        sub.ready();
        resolve();
      };
    });
  }

  /** Signals readiness, as the real driver import resolving would. */
  ready(): void {
    this.release?.();
  }
}

let t: TestContext;

afterEach(async () => {
  await t?.stop();
});

describe("startAndWaitReady and context:error", () => {
  /**
   * @case A startup exchange fails while a sibling source is still coming up
   * @preconditions A route with two sources, one firing immediately into a
   *   step that throws and one that has not signalled readiness yet, so the
   *   pipeline failure lands before `route:started`
   * @expectedResult The start resolves once the late source readies, and the
   *   failure is collected in `errors`. Rejecting here would make any route
   *   with a startup-firing source untestable the moment one of its
   *   exchanges could legitimately fail, and the caller would never reach
   *   the assertion that the failure is what it wanted to check.
   */
  test("does not reject when an exchange fails before the route starts", async () => {
    const late = new LateSource();
    const route = craft()
      .id("fails-at-startup")
      .input({ body: anything })
      .from(simple.value({}), late)
      .transform(() => {
        throw new Error("the credential is missing");
      })
      .to(noop());

    t = await testContext({ routesReadyTimeout: "5s" }).routes([route]).build();
    const ready = t.startAndWaitReady();
    // Released after the failing exchange has had the event loop, which is
    // the ordering that made this intermittent: whichever of the two got
    // there first decided whether the test saw a rejection.
    setTimeout(() => late.ready(), 50);
    await ready;
    await t.drain();

    expect(String(t.errors)).toContain("the credential is missing");
  });

  /**
   * @case A plugin that throws from its start hook
   * @preconditions The same shape of failure, minus an exchange, which is
   *   what the payload uses to tell the two apart
   * @expectedResult Still rejects. The narrowing above must not cost the
   *   guard its actual job, which is failing fast on a context that will
   *   never serve rather than timing out with no cause named.
   */
  test("still rejects when a plugin fails to start", async () => {
    const route = craft().id("healthy").from(simple.value({})).to(noop());
    const exploding = {
      apply: () => {},
      start: () => {
        throw new Error("plugin start blew up");
      },
    };

    // Held locally rather than on the shared `t`: `stop()` re-awaits the
    // start promise, so the teardown would rethrow this same failure.
    const failing = await testContext({ routesReadyTimeout: "5s" })
      .with({ plugins: [exploding] })
      .routes([route])
      .build();

    await expect(failing.startAndWaitReady()).rejects.toThrow(
      "plugin start blew up",
    );
    await failing.stop().catch(() => {});
  });
});
