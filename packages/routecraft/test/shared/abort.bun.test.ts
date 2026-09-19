import { describe, expect, test } from "bun:test";
import { HOOK_ABORTED, settleOrAbort } from "../../src/shared/abort.ts";

/**
 * `settleOrAbort` bounds every user-supplied hook the framework awaits inside
 * a step: the resume door's `authorize` and `elevate`, and the notification a
 * `recovery.defer()` directive carries. It had no direct tests despite being
 * the single place three copies of that scaffold were folded into.
 */
describe("settleOrAbort", () => {
  /**
   * @case A signal that is ALREADY aborted when the hook is handed over
   * @preconditions A controller aborted before the call, and a hook that records whether it ran
   * @expectedResult HOOK_ABORTED, and the hook is never invoked at all
   */
  test("refuses before running the hook when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;

    // `Promise.race` builds its array left to right, so a hook invoked in the
    // first element settles before the second can look at the signal. Running
    // a notification hook here would tell a human about work whose route is
    // already being torn down.
    const settled = settleOrAbort(() => {
      ran = true;
      return "hook result";
    }, controller.signal);

    await expect(settled).rejects.toBe(HOOK_ABORTED);
    expect(ran).toBe(false);
  });

  /**
   * @case A hook that settles before the signal fires
   * @preconditions A live signal that is never aborted
   * @expectedResult The hook's own value, with the abort listener removed rather than left on the signal
   */
  test("returns the hook's value and leaves no listener behind", async () => {
    const controller = new AbortController();
    let live = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = ((...a: unknown[]) => {
      live += 1;
      return (add as (...args: unknown[]) => unknown)(...a);
    }) as typeof add;
    controller.signal.removeEventListener = ((...a: unknown[]) => {
      live -= 1;
      return (remove as (...args: unknown[]) => unknown)(...a);
    }) as typeof remove;

    await expect(
      settleOrAbort(async () => "done", controller.signal),
    ).resolves.toBe("done");
    // Bounding a hook against a long-lived route signal must not accumulate.
    expect(live).toBe(0);
  });

  /**
   * @case A signal that fires while an async hook is still pending
   * @preconditions A hook that never settles on its own
   * @expectedResult HOOK_ABORTED rather than hanging
   */
  test("refuses when the signal fires while the hook is pending", async () => {
    const controller = new AbortController();
    const settled = settleOrAbort(
      () => new Promise<string>(() => {}),
      controller.signal,
    );
    controller.abort();

    await expect(settled).rejects.toBe(HOOK_ABORTED);
  });

  /**
   * @case A hook that throws synchronously
   * @preconditions A live signal, and a hook that throws rather than returning
   * @expectedResult The hook's own error, distinguishable from an abort
   */
  test("propagates what the hook threw rather than an abort", async () => {
    const controller = new AbortController();
    const boom = new Error("hook broke");

    await expect(
      settleOrAbort(() => {
        throw boom;
      }, controller.signal),
    ).rejects.toBe(boom);
  });

  /**
   * @case No signal supplied
   * @preconditions A hook and no bound, which is the caller's decision to make
   * @expectedResult The hook's value, unbounded
   */
  test("runs unbounded when no signal is supplied", async () => {
    await expect(settleOrAbort(async () => 42)).resolves.toBe(42);
  });
});
