import type {
  Destination,
  Enricher,
  Processor,
  Exchange,
} from "@routecraft/routecraft";
import { createSpyState } from "./shared.ts";

/**
 * A spy adapter that records all exchanges passing through it.
 * Implements {@link Destination} (send), {@link Enricher} (fetch), and
 * {@link Processor} so it can be used with `.to()`, `.tap()`, `.enrich()`,
 * and `.process()`. The fetch face returns the current body, so a bare
 * `.enrich(spy())` observes without changing the body.
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
  /* eslint-disable @typescript-eslint/no-explicit-any -- input positions use any: Destination/Enricher so the spy is assignable regardless of body type, Processor so spy<unknown>() is assignable in typed pipelines */
} & Destination<any> &
  Enricher<any, T> &
  Processor<any, T>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Creates a spy adapter that records all exchanges for test assertions.
 *
 * Use as a destination (`.to()`, `.enrich()`, `.tap()`) or processor (`.process()`)
 * to capture pipeline output without side effects.
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

  const adapter: SpyAdapter<T> = {
    adapterId: "routecraft.adapter.spy",
    // Placeholders: both are redefined below as non-enumerable, because a
    // step's description for the suspension hash folds an adapter's own
    // enumerable properties, and captured state that grows with every
    // delivery would move the digest under a parked exchange.
    received: state.received,
    calls: state.calls,

    send(exchange: Exchange<T>): void {
      state.received.push(exchange);
      state.calls.send++;
    },

    fetch(exchange: Exchange<T>): T {
      state.received.push(exchange);
      state.calls.enrich++;
      // Return the current body: a bare `.enrich(spy())` replaces the body
      // with itself, so the spy observes without altering the flow.
      return exchange.body;
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
  Object.defineProperty(adapter, "received", {
    value: state.received,
    enumerable: false,
  });
  Object.defineProperty(adapter, "calls", {
    value: state.calls,
    enumerable: false,
  });
  return adapter;
}
