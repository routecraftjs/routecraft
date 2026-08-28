import { describe, test, expect } from "bun:test";
import { craft } from "../src/builder.ts";
import { timer } from "../src/adapters/timer/index.ts";
import { cron } from "../src/adapters/cron/index.ts";
import { noop } from "../src/adapters/noop/index.ts";
import { CraftContext } from "../src/context.ts";
import { rcCodeOf } from "../src/brand.ts";

/**
 * Options renamed or removed in 0.7 must fail at build.
 *
 * TypeScript rejects them on an object literal, so every case here has to
 * bypass the types the way a real caller would: plain JS, an `as never`, or
 * an options object assembled elsewhere and spread in.
 */
describe("stale option names", () => {
  /**
   * @case A removed timer option is refused rather than ignored
   * @preconditions timer() called from JS with exactTime, which was removed in 0.7
   * @expectedResult RC5003 naming exactTime and pointing at cron(). Silently ignoring it would leave the timer on its 1000ms default, which is the failure the guard exists to prevent
   */
  test("refuses a removed timer option", () => {
    const options = { exactTime: "09:00:00" } as never;
    expect(() => timer(options)).toThrow(/exactTime/);
    try {
      timer(options);
    } catch (err) {
      expect(rcCodeOf(err)).toBe("RC5003");
      expect((err as Error).message).toMatch(/cron\(\)/);
    }
  });

  /**
   * @case The other removed timer option is refused too
   * @preconditions timer() called with timePattern, which was declared but never read
   * @expectedResult RC5003 naming timePattern
   */
  test("refuses the never-implemented timePattern", () => {
    expect(() => timer({ timePattern: "*" } as never)).toThrow(/timePattern/);
  });

  /**
   * @case A pre-0.7 Ms-suffixed name is refused and its replacement named
   * @preconditions timer() called with intervalMs, the pre-0.7 name for interval
   * @expectedResult RC5003 naming both intervalMs and interval, so the message is the migration
   */
  test("refuses an Ms-suffixed time option and names the new one", () => {
    expect(() => timer({ intervalMs: 60_000 } as never)).toThrow(
      /intervalMs.*interval/s,
    );
  });

  /**
   * @case jitterMs maps to maxJitter, not to the bare desuffixed name
   * @preconditions timer() and cron() called with jitterMs
   * @expectedResult Both refuse and both name maxJitter. A straight desuffixing would say "jitter", which is a fraction on retry() and would send the reader to the wrong option
   */
  test("points jitterMs at maxJitter on both schedule sources", () => {
    expect(() => timer({ jitterMs: 500 } as never)).toThrow(/maxJitter/);
    expect(() => cron("0 9 * * *", { jitterMs: 500 } as never)).toThrow(
      /maxJitter/,
    );
  });

  /**
   * @case The guard survives the spread that defeats excess-property checking
   * @preconditions An options object typed loosely elsewhere and spread into the call, which is how a renamed option reached seven call sites unnoticed before
   * @expectedResult RC5003, because the check is on the runtime keys rather than on the literal
   */
  test("catches a stale option arriving through a spread", () => {
    const partial: Record<string, unknown> = { delayMs: 100 };
    expect(() => timer({ ...partial } as never)).toThrow(/delayMs/);
  });

  /**
   * @case An inherited key is not the caller's own and must not fail the build
   * @preconditions An options object whose prototype carries exactTime, so `"exactTime" in opts` is true while Object.hasOwn is false
   * @expectedResult No throw. The two checks in the guard read the same set of keys, so a name the caller never wrote cannot refuse their route
   */
  test("ignores a stale name inherited from a prototype", () => {
    const proto = { exactTime: "09:00:00", intervalMs: 5 };
    const options = Object.create(proto) as Record<string, unknown>;
    options["interval"] = "5s";

    expect("exactTime" in options).toBe(true);
    expect(Object.hasOwn(options, "exactTime")).toBe(false);
    expect(() => timer(options as never)).not.toThrow();
  });

  /**
   * @case Operation options are guarded on the same terms as adapters
   * @preconditions Routes built with the pre-0.7 names on retry, circuitBreaker, debounce, sample and batch
   * @expectedResult Every one throws, naming the option the author wrote
   */
  test("refuses stale names on the pre-from operations", () => {
    expect(() => craft().retry({ backoffMs: 100 } as never)).toThrow(
      /backoffMs/,
    );
    expect(() =>
      craft().circuitBreaker({
        failureThreshold: 2,
        windowMs: 1000,
      } as never),
    ).toThrow(/windowMs/);
    expect(() =>
      craft()
        .id("d")
        .from(timer())
        .debounce({ waitMs: 100 } as never),
    ).toThrow(/waitMs/);
    expect(() =>
      craft()
        .id("s")
        .from(timer())
        .sample({ intervalMs: 100 } as never),
    ).toThrow(/intervalMs/);
    expect(() => craft().batch({ flushIntervalMs: 100 } as never)).toThrow(
      /flushIntervalMs/,
    );
  });

  /**
   * @case A stale config key fails when the context is built, not at shutdown
   * @preconditions A CraftContext constructed with shutdown.timeoutMs
   * @expectedResult RC5003 at construction. Checked in the constructor rather than in defineConfig() because defineConfig is an optional typing helper a config object can skip
   */
  test("refuses a stale shutdown key at context construction", () => {
    expect(
      () => new CraftContext({ shutdown: { timeoutMs: 5000 } } as never),
    ).toThrow(/timeoutMs/);
  });

  /**
   * @case Current names still build
   * @preconditions Routes and a context using the 0.7 names, including a duration string
   * @expectedResult No throw. The guard keys off the Ms suffix, so it must not fire on anything a user is meant to write
   */
  test("leaves current option names alone", () => {
    expect(() =>
      craft()
        .id("fine")
        .retry({ maxAttempts: 2, backoff: "1s" })
        .from(timer({ interval: "5s", maxJitter: 250 }))
        .to(noop()),
    ).not.toThrow();
    expect(
      () => new CraftContext({ shutdown: { timeout: "5s" } }),
    ).not.toThrow();
  });
});
