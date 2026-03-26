import {
  HeadersKeys,
  type Destination,
  type Processor,
  type Exchange,
} from "@routecraft/routecraft";
import { createSpyState } from "./shared.ts";

/**
 * A spy adapter that records all exchanges passing through it.
 * Implements both {@link Destination} and {@link Processor} so it can be used
 * with `.to()`, `.enrich()`, `.tap()`, and `.process()`.
 */
export type SpyAdapter<T = unknown> = {
  /** Stable identifier for this adapter. */
  adapterId: string;

  /** All exchanges recorded, in order. */
  received: Exchange<T>[];

  /** Per-operation call counters. */
  calls: { send: number; process: number; enrich: number };

  /** Clear all recorded data and reset counters. */
  reset(): void;

  /** Most recent exchange. Throws if none recorded. */
  lastReceived(): Exchange<T>;

  /** Array of just the body values from received exchanges. */
  receivedBodies(): T[];
  /* eslint-disable @typescript-eslint/no-explicit-any -- both positions use any: Destination so the spy is assignable regardless of body type, Processor so spy<unknown>() is assignable in typed pipelines */
} & Destination<any, void> &
  Processor<any, T>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Creates a spy adapter that records all exchanges for test assertions.
 *
 * Use as a destination (`.to()`, `.enrich()`, `.tap()`) or processor (`.process()`)
 * to capture pipeline output without side effects.
 *
 * @experimental
 *
 * @returns A spy adapter that records exchanges and tracks call counts
 *
 * @example
 * ```ts
 * const s = spy();
 * const route = craft().id("test").from(simple("hello")).to(s);
 * const t = await testContext().routes(route).build();
 * await t.test();
 *
 * expect(s.received).toHaveLength(1);
 * expect(s.received[0].body).toBe("hello");
 * expect(s.calls.send).toBe(1);
 * ```
 */
export function spy<T = unknown>(): SpyAdapter<T> {
  const state = createSpyState<T>();

  return {
    adapterId: "routecraft.adapter.spy",
    received: state.received,
    calls: state.calls,

    send(exchange: Exchange<T>): void {
      state.received.push(exchange);

      const operation = exchange.headers?.[HeadersKeys.OPERATION];
      if (operation === "enrich") {
        state.calls.enrich++;
      } else {
        state.calls.send++;
      }
    },

    process(exchange: Exchange<T>): Exchange<T> {
      state.received.push(exchange);
      state.calls.process++;
      return exchange;
    },

    reset(): void {
      state.received.length = 0;
      state.calls.send = 0;
      state.calls.process = 0;
      state.calls.enrich = 0;
    },

    lastReceived(): Exchange<T> {
      if (state.received.length === 0) {
        throw new Error("SpyAdapter: no exchanges recorded");
      }
      return state.received[state.received.length - 1];
    },

    receivedBodies(): T[] {
      return state.received.map((e) => e.body);
    },
  };
}
