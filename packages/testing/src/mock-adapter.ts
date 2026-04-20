import type {
  AdapterOverride,
  AdapterSendCall,
  AdapterSourceCall,
  SendOverrideHandler,
  Source,
  SourceOverrideBehavior,
} from "@routecraft/routecraft";

/**
 * Brand symbol stamped on the handles returned by `mockAdapter()`.
 *
 * `testContext().override()` uses this symbol to distinguish a mock handle
 * from a raw `AdapterOverride` (both objects carry a `calls` field, so a
 * structural check on a non-branded key would be fragile).
 *
 * Use `Symbol.for` so cross-realm / multi-package-load equality holds.
 *
 * @internal
 */
export const ADAPTER_MOCK_BRAND: unique symbol = Symbol.for(
  "routecraft.testing.adapter-mock",
);

/**
 * Extract the message type `M` from an adapter factory or adapter class,
 * so `mockAdapter(target, { source: [...] })` can check fixtures against
 * the real adapter shape. Falls back to `unknown` when `target` has no
 * inferable Source role (e.g. destination-only factories, or overloaded
 * factories where TypeScript cannot pick the source overload).
 */
type InferAdapterMessage<T> = T extends new (...args: never[]) => infer I
  ? I extends Source<infer M>
    ? M
    : unknown
  : T extends (...args: never[]) => infer R
    ? R extends Source<infer M>
      ? M
      : unknown
    : unknown;

/**
 * Behaviour description for a mock adapter. A mock may stub the source side,
 * the destination side, or both. The framework picks the matching behaviour
 * based on the call site's role in the route.
 *
 * @experimental
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
 * @experimental
 */
export interface AdapterMock {
  /** Brand used by `testContext().override()` to discriminate handles from raw overrides. */
  readonly [ADAPTER_MOCK_BRAND]: true;
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
 * Type guard that distinguishes an `AdapterMock` (handle returned by
 * `mockAdapter()`) from a raw `AdapterOverride` value.
 *
 * @internal
 */
export function isAdapterMock(
  value: AdapterMock | AdapterOverride,
): value is AdapterMock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [ADAPTER_MOCK_BRAND]?: unknown })[ADAPTER_MOCK_BRAND] === true
  );
}

/**
 * Create a mock for an adapter. The `target` may be either:
 *
 * - An adapter factory (e.g. `mail`, `http`, `mcp`). The mock matches every
 *   adapter instance produced by that factory. Requires the factory to stamp
 *   its adapters via `tagAdapter()`.
 * - An adapter class (e.g. `MailSourceAdapter`, `HttpDestinationAdapter`).
 *   The mock matches any adapter whose `constructor === target`. Works for
 *   every adapter without opt-in tagging, including third-party ones.
 *
 * Pass the result to `testContext().override(mock)` and run the route
 * under test as-is; the framework invokes the mock's `source` / `send`
 * handlers in place of the real adapter at every matching call site.
 *
 * @experimental
 * @param target - The adapter factory or adapter class to intercept
 * @param behavior - Source and/or destination-role handlers
 * @returns A handle with `calls` for assertions and an internal `override`
 *
 * @example
 * ```ts
 * // Factory form (preferred for single-role factories)
 * import { http, mail } from "@routecraft/routecraft";
 * import { mockAdapter, testContext } from "@routecraft/testing";
 *
 * const httpMock = mockAdapter(http, {
 *   send: async () => ({ status: 200, body: { ok: true } }),
 * });
 *
 * const mailMock = mockAdapter(mail, {
 *   source: [{ uid: 1, from: "a@b", subject: "hi", ... }],
 *   send: async () => ({ messageId: "<fake>" }),
 * });
 *
 * // Class form (works for any adapter, including third-party ones)
 * import { SomeAdapterClass } from "third-party-adapter";
 *
 * const thirdPartyMock = mockAdapter(SomeAdapterClass, {
 *   send: async () => ({ ok: true }),
 * });
 *
 * const t = await testContext()
 *   .override(httpMock)
 *   .override(mailMock)
 *   .override(thirdPartyMock)
 *   .routes(route)
 *   .build();
 * await t.test();
 * ```
 */
export function mockAdapter<
  T extends
    | ((...args: never[]) => unknown)
    | (new (...args: never[]) => unknown),
  M = InferAdapterMessage<T>,
>(target: T, behavior: MockAdapterBehavior<M>): AdapterMock {
  const override: AdapterOverride = {
    target,
    calls: { source: [], send: [] },
  };
  if (behavior.source !== undefined) {
    override.source = behavior.source as SourceOverrideBehavior;
  }
  if (behavior.send !== undefined) {
    override.send = behavior.send;
  }
  return {
    [ADAPTER_MOCK_BRAND]: true,
    override,
    get calls() {
      // Snapshot the live arrays so the `readonly` contract on AdapterMock.calls
      // is honoured at runtime (users cannot mutate the recorded calls via
      // the returned reference).
      return {
        source: [...override.calls.source],
        send: [...override.calls.send],
      };
    },
  };
}
