import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  http,
  noop,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
} from "@routecraft/routecraft";
import { encodeSseFrame } from "../src/plugins/http/sse.ts";

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

async function boot(
  opts: BootOptions,
): Promise<{ ctx: TestContext; port: number }> {
  let resolvedPort = 0;
  const builder = testContext()
    .on(
      "server:listening" as EventName,
      ((payload: { details: unknown }) => {
        resolvedPort = (payload.details as { port: number }).port;
      }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
    )
    .routes(opts.routes)
    .with({
      servers: { default: { port: 0 } },
      http: opts.http ?? {},
    } as CraftConfig);
  for (const [name, handler] of Object.entries(opts.events ?? {})) {
    builder.on(
      name as EventName,
      handler as Parameters<ReturnType<typeof testContext>["on"]>[1],
    );
  }
  const ctx = await builder.build();
  await ctx.startAndWaitReady();
  expect(resolvedPort).toBeGreaterThan(0);
  return { ctx, port: resolvedPort };
}

/** Read a whole response body as text, for streams the route terminates itself. */
async function readAll(res: Response): Promise<string> {
  return await res.text();
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

    const deadline = Date.now() + 2000;
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closed).toBe(true);
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

    const deadline = Date.now() + 2000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = events.find((e) => e.path === "/slow");
    expect(completed).toBeDefined();
    expect(completed!.status).toBe(200);
    expect(completed!.routeId).toBe("slow");
    expect(completed!.durationMs).toBeGreaterThanOrEqual(100);
  });
});
