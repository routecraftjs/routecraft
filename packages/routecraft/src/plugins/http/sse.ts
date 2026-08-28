/**
 * Streaming response bodies for the http source: SSE framing for an
 * `AsyncIterable`, byte passthrough for a `ReadableStream`.
 *
 * The dispatcher normalises every route result to a `Response`, and a
 * streaming body is one more entry in that convention table rather than a
 * transport of its own. SSE needs no upgrade and no second request shape:
 * one exchange, one response, the pre-from chain applied once at entry.
 * That is why it lives on `http()` and not behind an `sse()` adapter.
 *
 * Both runtimes already carry the bytes. `Bun.serve` streams a
 * stream-bodied `Response` natively, and the `node:http` shim pumps the
 * body reader chunk by chunk with client-abort propagation. What this
 * module adds is the framing, the cancel path into the route's iterator,
 * and the single end-of-stream signal the dispatcher needs to close out
 * its per-request event.
 */

/** Default content type for the SSE arm, overridable per response. */
export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/**
 * Cache directive every event stream carries. A cached event stream is a
 * contradiction, and an intermediary that buffers one turns a live feed
 * into a delayed batch.
 */
export const SSE_CACHE_CONTROL = "no-cache";

/**
 * One yielded SSE event.
 *
 * A yielded object is read as this descriptor when it carries an own `data`
 * property; every other object is itself the payload and is JSON-encoded
 * into `data`. Keys outside the four SSE fields are not sent, so a domain
 * object that happens to have a `data` field is mapped in a `.transform()`
 * step rather than yielded raw.
 */
export interface SseEvent {
  /** Payload. Strings are sent verbatim, anything else is JSON-encoded. */
  data: unknown;
  /** Event name, read by `addEventListener(name)` on an `EventSource`. */
  event?: string;
  /** Last event id, echoed back by a reconnecting client as `Last-Event-ID`. */
  id?: string | number;
  /** Reconnection delay in whole milliseconds. */
  retry?: number;
}

const encoder = new TextEncoder();

/**
 * Strip the characters that would end the field or the frame.
 *
 * A route builds `event` and `id` from its own data, and a newline in
 * either would let that data close the frame and forge the next one. The
 * SSE grammar has no escape for it, so the character is removed rather
 * than encoded. `id` additionally may not carry U+0000 (the field is
 * ignored wholesale by a conforming client if it does).
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

function isSseEvent(value: object): value is SseEvent {
  return Object.hasOwn(value, "data");
}

/**
 * Serialise one yielded value into SSE wire bytes.
 *
 * Strings and `Uint8Array`s pass through untouched: they are the escape
 * hatch for a route that already speaks the protocol (a `": ping"`
 * heartbeat, a hand-built frame, or a completely different line format
 * behind a `contentType` override). Such a value carries its own frame
 * terminator; nothing is appended.
 *
 * `undefined` yields nothing, so a producer can filter without branching
 * at every yield site.
 */
export function encodeSseFrame(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return encoder.encode(value);

  const event =
    typeof value === "object" && value !== null && isSseEvent(value)
      ? value
      : { data: value };

  let frame = "";
  if (typeof event.event === "string" && event.event.length > 0) {
    frame += `event: ${singleLine(event.event)}\n`;
  }
  if (typeof event.id === "string" || typeof event.id === "number") {
    frame += `id: ${singleLine(String(event.id))}\n`;
  }
  // Whole non-negative milliseconds only: a client parsing anything else
  // ignores the field, and a route that meant to send one deserves to see
  // its value rejected here rather than silently dropped on the wire.
  if (
    typeof event.retry === "number" &&
    Number.isInteger(event.retry) &&
    event.retry >= 0
  ) {
    frame += `retry: ${event.retry}\n`;
  }

  const payload =
    typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  // JSON.stringify returns undefined for undefined and for a function; an
  // event with no representable payload still needs its `data` field, or a
  // client reading `event.data` gets the previous frame's value.
  for (const line of (payload ?? "").split(/\r\n|\r|\n/)) {
    frame += `data: ${line}\n`;
  }
  return encoder.encode(`${frame}\n`);
}

/**
 * A stream body reduced to the two calls the pump makes of it, so the SSE
 * arm and the raw-passthrough arm share one lifecycle.
 */
interface ChunkSource {
  next(): Promise<{ done?: boolean; value?: Uint8Array | undefined }>;
  cancel(reason: unknown): Promise<void>;
}

function iterableSource(iterable: AsyncIterable<unknown>): ChunkSource {
  const iterator = iterable[Symbol.asyncIterator]();
  return {
    async next() {
      const step = await iterator.next();
      return step.done === true
        ? { done: true, value: undefined }
        : { done: false, value: encodeSseFrame(step.value) };
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  };
}

function streamSource(stream: ReadableStream<Uint8Array>): ChunkSource {
  const reader = stream.getReader();
  return {
    next: () => reader.read(),
    cancel: (reason) => reader.cancel(reason),
  };
}

/**
 * The comment an event stream opens with.
 *
 * Neither runtime puts the status line on the wire until the body produces
 * its first chunk, so a stream that is quiet to begin with, which is most
 * of them, leaves the client's `fetch` unresolved and an `EventSource`
 * without its `open`. One comment fixes that: the SSE grammar defines it as
 * a no-op, every conforming client discards it, and it costs nine bytes.
 */
const SSE_PREAMBLE = ": open\n\n";

export interface StreamBodyOptions {
  /** The request's signal. Aborting it cancels the source. */
  signal: AbortSignal;
  /**
   * Open the stream with the SSE comment above, flushing the response
   * headers before the first event. Only for a response that actually is
   * an event stream: any other body owns its bytes from the first one.
   */
  preamble?: boolean;
  /**
   * Called exactly once when the response body is finished, whichever way
   * it finished: drained, cancelled by a disconnect, or failed mid-flight.
   * The dispatcher's per-request event hangs off this, which is what makes
   * `durationMs` span request receipt to stream end.
   */
  onEnd: (error?: unknown) => void;
  /**
   * Called when tearing the source down fails, which is separate from the
   * body ending. Cancelling runs the route's own cleanup, and a cleanup that
   * throws is the route's bug: it must be reported, but it cannot change a
   * response that has already been delivered and closed out.
   */
  onCleanupError?: (error: unknown) => void;
}

/**
 * Wrap a stream body in a `ReadableStream` that cancels its source when
 * the client goes away.
 *
 * `pull` rather than an eager loop in `start`, so a slow consumer's
 * back-pressure reaches the producer instead of buffering the whole stream
 * in the queue. Disconnect arrives by two doors and both are wired: the
 * runtime cancels the response body (Bun natively, the node shim through
 * `reader.cancel`), and the request's own signal fires. Whichever comes
 * first calls `return()` on the route's iterator, which is what a
 * `for await` loop or a generator's `finally` block sees.
 *
 * A generator parked on an inner `await` when the client disconnects sees
 * its `return()` queued behind that pending `next()`: async iteration
 * settles a pending step before it delivers a return. A producer that must
 * unblock promptly watches its own cancellation source.
 */
export function streamResponseBody(
  body: AsyncIterable<unknown> | ReadableStream<Uint8Array>,
  options: StreamBodyOptions,
): ReadableStream<Uint8Array> {
  const source =
    body instanceof ReadableStream ? streamSource(body) : iterableSource(body);

  let ended = false;
  const end = (error?: unknown): void => {
    if (ended) return;
    ended = true;
    options.signal.removeEventListener("abort", onAbort);
    options.onEnd(error);
  };
  /**
   * Tear down the source without letting its failure escape.
   *
   * Cancelling runs the route's own cleanup: `iterator.return()` lands in a
   * generator's `finally`, which is exactly where an author writes
   * `await conn.close()`. A rejection from that had nothing to catch it, and
   * an unhandled rejection ends the process on both runtimes, so one client
   * disconnecting from a route whose cleanup failed took the server down.
   * Reported rather than discarded, and on its own channel: by the time a
   * cancel settles the body has already ended, so `onEnd` has fired and the
   * request is closed out. A cleanup that fails afterwards is the route's,
   * not the response's.
   */
  const cancelSource = (reason: unknown): void => {
    void Promise.resolve(source.cancel(reason)).catch((error: unknown) => {
      options.onCleanupError?.(error);
    });
  };
  function onAbort(): void {
    cancelSource(options.signal.reason);
    end();
  }
  options.signal.addEventListener("abort", onAbort, { once: true });
  // An abort that landed before this wiring never invokes the listener, and
  // a runtime under no obligation to read a body it has given up on (Bun,
  // where the response is neither pulled nor cancelled) then leaves the
  // route's source running with nothing to stop it.
  if (options.signal.aborted) onAbort();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.preamble === true) {
        controller.enqueue(encoder.encode(SSE_PREAMBLE));
      }
    },
    async pull(controller) {
      // The client may have gone while this stream sat in the queue, in
      // which case no cancel is coming and the pump has to notice itself.
      if (options.signal.aborted) {
        cancelSource(options.signal.reason);
        controller.close();
        end();
        return;
      }
      try {
        const step = await source.next();
        if (step.done === true) {
          controller.close();
          end();
          return;
        }
        if (step.value !== undefined && step.value.length > 0) {
          controller.enqueue(step.value);
        }
      } catch (error) {
        // The status line left long ago, so there is no failure to report
        // on the wire beyond an unterminated body. The dispatcher logs it.
        controller.error(error);
        end(error);
      }
    },
    cancel(reason) {
      // Ended before the teardown, not after: `return()` into a generator
      // parked on an inner await sits behind that pending `next()`, and the
      // request's completion must not wait on something that may never
      // settle. Not awaited for the same reason.
      end();
      cancelSource(reason);
    },
  });
}

export function isReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  );
}

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * The plain SSE response, for a routecraft-owned surface that streams
 * events of its own rather than serving a route's body.
 *
 * The http dispatcher does not use this: a route's response also carries
 * whatever status and headers the exchange asked for, so it builds its own.
 * What both share is the pair of header values, which are decided above.
 */
export function sseResponse(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): Response {
  return new Response(
    streamResponseBody(events, { signal, preamble: true, onEnd: () => {} }),
    {
      status: 200,
      headers: {
        "content-type": SSE_CONTENT_TYPE,
        "cache-control": SSE_CACHE_CONTROL,
      },
    },
  );
}
