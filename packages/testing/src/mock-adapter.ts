import type {
  AdapterOverride,
  AdapterSendCall,
  AdapterSourceCall,
  SendOverrideHandler,
  SourceOverrideBehavior,
} from "@routecraft/routecraft";

/**
 * Behaviour description for a mock adapter. A mock may stub the source side,
 * the destination side, or both. The framework picks the matching behaviour
 * based on the call site's role in the route.
 *
 * @beta
 */
export interface MockAdapterBehavior<M = unknown> {
  /**
   * Source-role behaviour. Used when the adapter is the `.from()` of a route.
   * Pass an array of fixtures, an async iterable, or a callable that receives
   * the construction args and returns the stream to emit.
   */
  source?: SourceOverrideBehavior<M>;
  /**
   * Destination-role behaviour. Used when the adapter is passed to `.to()`,
   * `.enrich()`, or `.tap()`. Receives the exchange and a meta object with
   * the construction args; returning a value replaces the body upstream.
   */
  send?: SendOverrideHandler;
}

/**
 * Handle returned by `mockAdapter(factory, behaviour)`. Carries the resolved
 * override the framework should install on the context, plus `calls` for
 * assertions.
 *
 * @beta
 */
export interface AdapterMock {
  readonly override: AdapterOverride;
  /**
   * Recorded calls, populated as the route runs. Assert on these after
   * awaiting `t.test()`.
   */
  readonly calls: {
    source: readonly AdapterSourceCall[];
    send: readonly AdapterSendCall[];
  };
}

/**
 * Create a mock for an adapter factory. Pass the result to
 * `testContext().override(mock)` and run the route under test as-is; the
 * framework will invoke the mock's `source` / `send` handlers in place of
 * the real adapter at every call site that was constructed via this factory.
 *
 * @beta
 * @param factory - The adapter factory to intercept (e.g. `mail`, `http`)
 * @param behavior - Source and/or destination-role handlers
 * @returns A handle with `calls` for assertions and an internal `override`
 *
 * @example
 * ```ts
 * import { mail } from "@routecraft/routecraft";
 * import { mockAdapter, testContext } from "@routecraft/testing";
 * import { route } from "../src/mail-triage";
 *
 * const mailMock = mockAdapter(mail, {
 *   source: [
 *     { uid: 1, from: "a@b", subject: "hi", ... },
 *   ],
 *   send: async (exchange, { args }) => {
 *     if (args[0]?.action === "move") return { moved: true };
 *     return { messageId: "<fake>" };
 *   },
 * });
 *
 * const t = await testContext().override(mailMock).routes(route).build();
 * await t.test();
 *
 * expect(mailMock.calls.send).toHaveLength(2);
 * ```
 */
export function mockAdapter<
  F extends (...args: never[]) => unknown,
  M = unknown,
>(factory: F, behavior: MockAdapterBehavior<M>): AdapterMock {
  const override: AdapterOverride = {
    factory,
    calls: { source: [], send: [] },
  };
  if (behavior.source !== undefined) {
    override.source = behavior.source as SourceOverrideBehavior;
  }
  if (behavior.send !== undefined) {
    override.send = behavior.send;
  }
  return {
    override,
    get calls() {
      return override.calls;
    },
  };
}
