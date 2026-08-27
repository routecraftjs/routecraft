import type { AgentDelta, AgentDeltaListener } from "./events.ts";

/**
 * The delta iterable an agent dispatch produces under `stream: true`.
 *
 * Named so a route's declared output type says what it carries. It is an
 * ordinary async iterable, so the http dispatcher frames it as SSE, a
 * `.transform()` step can map it into named events, and a `for await` in
 * a `.process()` step consumes it directly.
 */
export type AgentStream = AsyncIterable<AgentDelta>;

/**
 * Deltas held for a consumer that has fallen behind before the model is
 * made to wait for it.
 *
 * Some slack, because a token arriving while the previous one is being
 * written to a socket should not stall the provider stream; a bound,
 * because a consumer that stopped reading must not be able to buffer a
 * whole generation in memory. The provider's own stream is pull-based, so
 * the wait propagates the whole way back.
 */
const DELTA_BUFFER = 64;

/**
 * Turn a streaming agent run into an iterable of its deltas.
 *
 * The run is started here and not awaited: the caller receives the iterable
 * immediately and the session fills it as the model writes, which is the
 * whole point of `stream: true`. The consolidated result is dropped, since
 * a route that asked for deltas asked for them instead of it.
 *
 * `cancel` is the other half. A consumer that stops iterating (an SSE
 * client that disconnected, a `break` out of a `for await`) reaches the
 * generator's `finally`, which aborts the run rather than leaving a model
 * generating into a queue nobody will read.
 */
export function streamAgentDeltas(
  run: (onDelta: AgentDeltaListener) => Promise<unknown>,
  cancel: (reason: unknown) => void,
): AgentStream {
  const buffer: AgentDelta[] = [];
  let settled = false;
  let failure: unknown;
  let wakeConsumer: (() => void) | undefined;
  let wakeProducer: (() => void) | undefined;

  const releaseProducer = (): void => {
    const resume = wakeProducer;
    wakeProducer = undefined;
    resume?.();
  };

  const onDelta: AgentDeltaListener = async (delta) => {
    buffer.push(delta);
    wakeConsumer?.();
    if (buffer.length >= DELTA_BUFFER) {
      await new Promise<void>((resolve) => {
        wakeProducer = resolve;
      });
    }
  };

  void run(onDelta).then(
    () => {
      settled = true;
      wakeConsumer?.();
    },
    (error: unknown) => {
      failure = error;
      settled = true;
      wakeConsumer?.();
    },
  );

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<AgentDelta> {
      try {
        for (;;) {
          while (buffer.length > 0) {
            const delta = buffer.shift()!;
            if (buffer.length < DELTA_BUFFER) releaseProducer();
            yield delta;
          }
          if (settled) {
            // The run's failure is the stream's failure. It surfaces at
            // the point the consumer asked for the next delta, which is
            // the only place it can still be handled.
            if (failure !== undefined) throw failure;
            return;
          }
          await new Promise<void>((resolve) => {
            wakeConsumer = resolve;
          });
          wakeConsumer = undefined;
        }
      } finally {
        cancel(new Error("Agent delta stream was closed by its consumer"));
        // A producer parked on back-pressure would otherwise hold the run
        // open waiting for a consumer that has gone.
        releaseProducer();
      }
    },
  };
}
