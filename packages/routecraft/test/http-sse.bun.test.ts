import { describe, test, expect, afterEach } from "bun:test";
import {
  bootServer,
  testContext,
  waitFor,
  type BootedServer,
  type TestContext,
} from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  http,
  noop,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
} from "@routecraft/routecraft";
import { encodeSseFrame, streamResponseBody } from "../src/plugins/http/sse.ts";

const decoder = new TextDecoder();

function frame(value: unknown): string {
  const bytes = encodeSseFrame(value);
  return bytes === undefined ? "<none>" : decoder.decode(bytes);
}

interface BootOptions {
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0];
  http?: HttpPluginOptions;
  events?: Partial<Record<EventName, (ev: { details: unknown }) => void>>;
}

async function boot(opts: BootOptions): Promise<BootedServer> {
  return await bootServer((builder) => {
    builder.routes(opts.routes).with({
      servers: { default: { port: 0 } },
      http: opts.http ?? {},
    } as CraftConfig);
    for (const [name, handler] of Object.entries(opts.events ?? {})) {
      builder.on(
        name as EventName,
        handler as Parameters<ReturnType<typeof testContext>["on"]>[1],
      );
    }
    return builder;
  });
}

/** Read a whole response body as text, for streams the route terminates itself. */
async function readAll(res: Response): Promise<string> {
  return await res.text();
}

/**
 * The periodic-wake pattern published on the http adapter reference page,
 * under "Observing a disconnect". Kept byte-for-byte the same shape as the
 * documented example: the page promises a route built this way observes a
 * client disconnect within one interval, and the test below is what holds
 * that promise to the real server.
 */
const KEEP_ALIVE = Symbol("keep-alive");
const WAKE_MS = 100;

function withWake<T>(
  pending: Promise<T>,
  ms: number,
): Promise<T | typeof KEEP_ALIVE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = new Promise<typeof KEEP_ALIVE>((resolve) => {
    timer = setTimeout(() => resolve(KEEP_ALIVE), ms);
  });
  return Promise.race([pending, wake]).finally(() => clearTimeout(timer));
}

describe("SSE frame encoding", () => {
  /**
   * @case An object carrying `data` is read as an SSE event descriptor
   * @preconditions Yielded value is { event, data } with an object payload
   * @expectedResult "event:" line, then a JSON-encoded "data:" line, then a blank line
   */
  test("an object with data becomes an event descriptor", () => {
    expect(frame({ event: "message", data: { id: 7 } })).toBe(
      'event: message\ndata: {"id":7}\n\n',
    );
  });

  /**
   * @case An object without `data` is itself the payload
   * @preconditions Yielded value is a domain record with an `id` field and no `data`
   * @expectedResult The whole object is JSON-encoded into one data line, `id` not lifted to a field
   */
  test("an object without data is JSON-encoded whole", () => {
    expect(frame({ id: 42, name: "ada" })).toBe(
      'data: {"id":42,"name":"ada"}\n\n',
    );
  });

  /**
   * @case id and retry are emitted as their own fields when well-formed
   * @preconditions Descriptor carries id, a whole-millisecond retry, and string data
   * @expectedResult Fields appear in event/id/retry/data order with the string sent verbatim
   */
  test("id and retry ride their own fields", () => {
    expect(frame({ id: 12, retry: 3000, data: "tick" })).toBe(
      "id: 12\nretry: 3000\ndata: tick\n\n",
    );
  });

  /**
   * @case A fractional retry is dropped rather than sent unparseable
   * @preconditions Descriptor carries retry: 1.5
   * @expectedResult No retry line; the data line still goes out
   */
  test("a non-integer retry is not sent", () => {
    expect(frame({ retry: 1.5, data: "tick" })).toBe("data: tick\n\n");
  });

  /**
   * @case Multi-line string data is split across data lines per the spec
   * @preconditions Descriptor data contains an embedded newline
   * @expectedResult Two data lines, one frame
   */
  test("multi-line data becomes multiple data lines", () => {
    expect(frame({ data: "first\nsecond" })).toBe(
      "data: first\ndata: second\n\n",
    );
  });

  /**
   * @case Newlines in single-line fields cannot forge a frame boundary
   * @preconditions event and id carry CR/LF characters
   * @expectedResult The characters are stripped, leaving one field line each
   */
  test("newlines are stripped from event and id", () => {
    expect(frame({ event: "a\nb", id: "1\r\n2", data: "x" })).toBe(
      "event: ab\nid: 12\ndata: x\n\n",
    );
  });

  /**
   * @case Strings and byte arrays are the escape hatch and pass through untouched
   * @preconditions A raw SSE comment string and a Uint8Array are yielded
   * @expectedResult Bytes are emitted verbatim with no framing added
   */
  test("strings and byte arrays pass through raw", () => {
    expect(frame(": ping\n\n")).toBe(": ping\n\n");
    expect(frame(new TextEncoder().encode("data: raw\n\n"))).toBe(
      "data: raw\n\n",
    );
  });

  /**
   * @case A yielded undefined emits nothing at all
   * @preconditions Producer yields undefined to skip a tick
   * @expectedResult No bytes are produced
   */
  test("undefined yields no frame", () => {
    expect(encodeSseFrame(undefined)).toBeUndefined();
  });
});

describe("stream body teardown", () => {
  /**
   * @case A signal already aborted before the body is wired still cancels the source
   * @preconditions streamResponseBody is handed an AbortSignal that has already fired
   * @expectedResult The source is cancelled and onEnd fires, rather than the route's producer being left running
   */
  test("an already-aborted signal cancels the source", async () => {
    let returned = false;
    let ended = false;
    const iterable = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { data: "one" };
        } finally {
          returned = true;
        }
      },
    };
    const controller = new AbortController();
    controller.abort(new Error("gone before wiring"));

    streamResponseBody(iterable, {
      signal: controller.signal,
      onEnd: () => {
        ended = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(true);
    // The generator never started, so its finally never runs; what matters is
    // that cancellation was attempted rather than silently skipped.
    expect(returned).toBe(false);
  });

  /**
   * @case A route whose cleanup rejects does not take the process down
   * @preconditions Generator's finally throws; the client aborts mid-stream
   * @expectedResult The rejection reaches onCleanupError instead of escaping as an unhandled rejection that ends the process
   */
  test("a rejecting cleanup is reported, not thrown at the runtime", async () => {
    let reported: unknown;
    // Hand-rolled rather than a generator: what the pump actually sees is
    // `return()` rejecting, and writing it directly says so without a throw
    // inside a finally.
    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (sent) return await new Promise<never>(() => {});
            sent = true;
            return { done: false, value: { data: "one" } };
          },
          return: async () => {
            throw new Error("cleanup failed");
          },
        };
      },
    };
    const controller = new AbortController();
    const body = streamResponseBody(iterable, {
      signal: controller.signal,
      onEnd: () => {},
      onCleanupError: (error) => {
        reported ??= error;
      },
    });
    const reader = body.getReader();
    await reader.read();
    controller.abort(new Error("client gone"));

    await waitFor(() => reported !== undefined, 1000);
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("cleanup failed");
  });
});

describe("HTTP streaming responses", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case A route returning an AsyncIterable streams SSE by default
   * @preconditions Route transform returns an async generator yielding two descriptors
   * @expectedResult 200 with text/event-stream and cache-control: no-cache, body carries both frames
   */
  test("an AsyncIterable body streams as text/event-stream", async () => {
    const bound = await boot({
      routes: craft()
        .id("sse")
        .from(http({ path: "/sse", method: "GET" }))
        .transform(async function* () {
          yield { event: "tick", data: { n: 1 } };
          yield { event: "tick", data: { n: 2 } };
        })
        .to(noop()),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await readAll(res)).toBe(
      ': open\n\nevent: tick\ndata: {"n":1}\n\nevent: tick\ndata: {"n":2}\n\n',
    );
  });

  /**
   * @case The content type is overridable so a caller can pick ndjson
   * @preconditions Route sets routecraft.http.response.contentType and yields raw strings
   * @expectedResult The override wins; the yielded strings reach the wire byte for byte
   */
  test("a contentType override wins over the SSE default", async () => {
    const bound = await boot({
      routes: craft()
        .id("ndjson")
        .from(http({ path: "/ndjson", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            headers: {
              ...ex.headers,
              "routecraft.http.response.contentType": "application/x-ndjson",
            },
          }),
        )
        .transform(async function* () {
          yield '{"n":1}\n';
          yield '{"n":2}\n';
        })
        .to(noop()),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/ndjson`);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await readAll(res)).toBe('{"n":1}\n{"n":2}\n');
  });

  /**
   * @case A ReadableStream body passes through as raw chunked bytes
   * @preconditions Route returns a ReadableStream of two byte chunks, no header overrides
   * @expectedResult Bytes arrive unframed with the octet-stream default and no cache-control
   */
  test("a ReadableStream body is passed through unframed", async () => {
    const bound = await boot({
      routes: craft()
        .id("raw")
        .from(http({ path: "/raw", method: "GET" }))
        .transform(
          () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("alpha"));
                controller.enqueue(new TextEncoder().encode("beta"));
                controller.close();
              },
            }),
        )
        .to(noop()),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await readAll(res)).toBe("alphabeta");
  });

  /**
   * @case A client disconnect cancels the route's async iterator
   * @preconditions Endless generator with a finally block; the caller aborts after the first frame
   * @expectedResult The generator's finally runs, proving return() reached it
   */
  test("client disconnect cancels the iterator", async () => {
    let closed = false;
    const bound = await boot({
      routes: craft()
        .id("endless")
        .from(http({ path: "/endless", method: "GET" }))
        .transform(async function* () {
          try {
            for (let n = 0; ; n++) {
              yield { data: n };
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          } finally {
            closed = true;
          }
        })
        .to(noop()),
    });
    t = bound.ctx;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${bound.port}/endless`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    // Chunk boundaries are the runtime's business, so read until the first
    // frame has arrived rather than assuming it lands on its own.
    let opening = "";
    while (!opening.includes("data: 0")) {
      opening += decoder.decode((await reader.read()).value);
    }
    expect(opening.startsWith(": open\n\n")).toBe(true);
    controller.abort();

    expect(await waitFor(() => closed)).toBe(true);
  });

  /**
   * @case A cased Content-Type override replaces the header rather than duplicating it
   * @preconditions Route sets routecraft.http.response.headers with "Content-Type" in mixed case
   * @expectedResult One content-type on the wire, and no SSE preamble on a body the route declared as ndjson
   */
  test("a differently-cased content-type override wins cleanly", async () => {
    const bound = await boot({
      routes: craft()
        .id("cased")
        .from(http({ path: "/cased", method: "GET" }))
        .process(async (ex) =>
          DefaultExchange.rewrap(ex, {
            headers: {
              ...ex.headers,
              "routecraft.http.response.headers": {
                "Content-Type": "application/x-ndjson",
              },
            },
          }),
        )
        .transform(async function* () {
          yield '{"n":1}\n';
        })
        .to(noop()),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/cased`);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await readAll(res)).toBe('{"n":1}\n');
  });

  /**
   * @case A stream that breaks mid-flight is not reported as a success
   * @preconditions Generator throws after its first frame is already on the wire
   * @expectedResult The completed event carries the failure, so an operator cannot score it as a 200
   */
  test("a mid-stream failure rides the completed event", async () => {
    const events: Array<{
      path: string;
      error?: { name: string; message: string };
    }> = [];
    const bound = await boot({
      routes: craft()
        .id("breaks")
        .from(http({ path: "/breaks", method: "GET" }))
        .transform(async function* () {
          yield { data: "one" };
          throw new Error("producer gave up");
        })
        .to(noop()),
      events: {
        "plugin:http:request:completed": (ev) => {
          events.push(
            ev.details as {
              path: string;
              error?: { name: string; message: string };
            },
          );
        },
      },
    });
    t = bound.ctx;

    // Drained, not cancelled: `end()` latches on the first terminator, so a
    // client cancel racing the producer's throw would decide the recorded
    // outcome. Letting the producer end the stream leaves one terminator.
    const res = await fetch(`http://127.0.0.1:${bound.port}/breaks`);
    await res.text().catch(() => {});

    await waitFor(() => events.some((e) => e.path === "/breaks"));
    const completed = events.find((e) => e.path === "/breaks");
    expect(completed).toBeDefined();
    expect(completed!.error?.message).toBe("producer gave up");
  });

  /**
   * @case The per-request event is held back until the stream closes
   * @preconditions Generator sleeps between two frames; the caller reads to the end
   * @expectedResult One completed event with status 200 and a durationMs covering the whole stream
   */
  test("plugin:http:request:completed fires at stream close", async () => {
    const events: Array<{
      path: string;
      status: number;
      durationMs: number;
      routeId?: string;
    }> = [];
    const bound = await boot({
      routes: craft()
        .id("slow")
        .from(http({ path: "/slow", method: "GET" }))
        .transform(async function* () {
          yield { data: "one" };
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield { data: "two" };
        })
        .to(noop()),
      events: {
        "plugin:http:request:completed": (ev) => {
          events.push(
            ev.details as {
              path: string;
              status: number;
              durationMs: number;
              routeId?: string;
            },
          );
        },
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/slow`);
    const body = await readAll(res);
    expect(body).toBe(": open\n\ndata: one\n\ndata: two\n\n");

    await waitFor(() => events.length > 0);
    const completed = events.find((e) => e.path === "/slow");
    expect(completed).toBeDefined();
    expect(completed!.status).toBe(200);
    expect(completed!.routeId).toBe("slow");
    expect(completed!.durationMs).toBeGreaterThanOrEqual(100);
  });

  /**
   * @case The documented periodic-wake pattern lets a disconnect reach a producer parked on a slow source
   * @preconditions A source promise that never resolves, wrapped in the `withWake` shape from the http reference page with a 100ms interval; the caller aborts after the first keep-alive
   * @expectedResult The generator's finally runs within a few wake intervals rather than never, since without the wake the pending step never settles and the queued return() is never delivered
   */
  test("a periodic wake delivers a disconnect to a parked producer", async () => {
    let closed = false;
    // The source the route is waiting on, standing in for one that can be
    // quiet for minutes. It never settles, so the wake is the only thing
    // that can return control to the loop.
    const nextEvent = (): Promise<string> => new Promise<string>(() => {});

    const bound = await boot({
      routes: craft()
        .id("slow-feed")
        .from(http({ path: "/feed", method: "GET" }))
        .transform(async function* () {
          let pending = nextEvent();
          try {
            for (;;) {
              const next = await withWake(pending, WAKE_MS);
              if (next === KEEP_ALIVE) {
                yield ": keep-alive\n\n";
                continue;
              }
              pending = nextEvent();
              yield { event: "update", data: next };
            }
          } finally {
            closed = true;
          }
        })
        .to(noop()),
    });
    t = bound.ctx;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${bound.port}/feed`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    let opening = "";
    while (!opening.includes(": keep-alive")) {
      opening += decoder.decode((await reader.read()).value);
    }
    controller.abort();

    const abortedAt = Date.now();
    expect(await waitFor(() => closed, 2000)).toBe(true);
    // Bounded by the wake, not by the source: a generous ceiling that still
    // fails if the return has to wait on `nextEvent()`, which never settles.
    expect(Date.now() - abortedAt).toBeLessThan(1000);
  });
});
