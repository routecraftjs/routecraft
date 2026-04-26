import { describe, test, expect, afterEach } from "vitest";
import {
  craft,
  simple,
  http,
  mail,
  file,
  csv,
  json,
  jsonl,
  html,
  type Destination,
  type Source,
  type Exchange,
  type ExchangeHeaders,
  type CraftContext,
  type AdapterOverride,
} from "@routecraft/routecraft";
import {
  mockAdapter,
  testContext,
  spy,
  type AdapterMock,
  type MockAdapterBehavior,
  type TestContext,
} from "@routecraft/testing";

const RC_ADAPTER_FACTORY = Symbol.for("routecraft.adapter.factory");

function readFactoryTag(adapter: unknown): unknown {
  return (adapter as Record<symbol, unknown>)[RC_ADAPTER_FACTORY];
}

/**
 * A handwritten destination class with a stable constructor. Used to
 * exercise the class-based override path where no factory tagging exists.
 */
class PlainDestination<R = { ok: true }> implements Destination<unknown, R> {
  constructor(public readonly label: string) {}
  async send(exchange: Exchange): Promise<R> {
    void exchange;
    return { ok: true } as R;
  }
}

function plainDestination<R = { ok: true }>(
  label: string,
): PlainDestination<R> {
  return new PlainDestination<R>(label);
}

/**
 * Handwritten source class. Never yields anything on its own; the source
 * override is expected to stand in.
 */
class PlainSource<M = unknown> implements Source<M> {
  constructor(public readonly label: string) {}
  async subscribe(
    _context: CraftContext,
    _handler: (message: M, headers?: ExchangeHeaders) => Promise<Exchange>,
    _abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    onReady?.();
  }
}

function plainSource<M = unknown>(label: string): PlainSource<M> {
  return new PlainSource<M>(label);
}

describe("mockAdapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  describe("return shape", () => {
    /**
     * @case mockAdapter returns a handle with override.target set to the argument
     * @preconditions Called with a factory reference
     * @expectedResult override.target identity-matches the factory
     */
    test("stores the target on the override", () => {
      const mock = mockAdapter(http, { send: async () => ({}) });
      expect(mock.override.target).toBe(http);
    });

    /**
     * @case mockAdapter omits the source handler when behavior has no `source`
     * @preconditions Called with send-only behavior
     * @expectedResult override.source is undefined; override.send is set
     */
    test("omits source handler when not provided", () => {
      const mock = mockAdapter(http, { send: async () => ({}) });
      expect(mock.override.source).toBeUndefined();
      expect(mock.override.send).toBeDefined();
    });

    /**
     * @case mockAdapter omits the send handler when behavior has no `send`
     * @preconditions Called with source-only behavior
     * @expectedResult override.send is undefined; override.source is set
     */
    test("omits send handler when not provided", () => {
      const mock = mockAdapter(http, { source: [1, 2, 3] });
      expect(mock.override.send).toBeUndefined();
      expect(mock.override.source).toBeDefined();
    });

    /**
     * @case calls getter returns a snapshot, not a live reference
     * @preconditions Behavior recorded a send call; caller held the first `calls` reference
     * @expectedResult Subsequent calls.send.length reflects the new count, but the prior snapshot does not
     */
    test("calls getter returns a snapshot", () => {
      const mock = mockAdapter(http, { send: async () => ({}) });
      const snapshotBefore = mock.calls;
      expect(snapshotBefore.send).toHaveLength(0);

      // Simulate the framework pushing a call onto the live array.
      mock.override.calls.send.push({
        args: [{ url: "x" }],
        exchange: { id: "e1", body: undefined, headers: {} },
        result: undefined,
      });

      expect(snapshotBefore.send).toHaveLength(0);
      expect(mock.calls.send).toHaveLength(1);
    });
  });

  describe("factory-form matching", () => {
    /**
     * @case mock with http factory intercepts .to(http(...)) calls
     * @preconditions Route sends via http() to an unreachable URL; mock is registered
     * @expectedResult The send handler runs instead of the real adapter; calls.send has one entry
     */
    test("intercepts adapters tagged with the factory", async () => {
      const mock = mockAdapter(http, {
        send: async () => ({
          status: 201,
          headers: {},
          body: { mocked: true },
          url: "unreachable",
        }),
      });

      const route = craft()
        .from(simple({ payload: 1 }))
        .to(http({ url: "http://127.0.0.1:0/never", method: "POST" }));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(mock.calls.send).toHaveLength(1);
      const [call] = mock.calls.send;
      expect(call.result).toMatchObject({ status: 201 });
      expect(t.errors).toHaveLength(0);
    });

    /**
     * @case send handler receives factory args via meta
     * @preconditions Route calls http({ url, method })
     * @expectedResult The handler's meta.args equals [{ url, method }]
     */
    test("send handler receives factory args", async () => {
      const opts = { url: "http://127.0.0.1:0/x", method: "GET" as const };
      let capturedArgs: unknown[] | undefined;
      const mock = mockAdapter(http, {
        send: async (_exchange, { args }) => {
          capturedArgs = args;
          return { status: 200, headers: {}, body: {}, url: opts.url };
        },
      });

      const route = craft()
        .from(simple({ x: 1 }))
        .to(http(opts));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(capturedArgs).toEqual([opts]);
    });
  });

  describe("class-form matching", () => {
    /**
     * @case mock with an adapter class intercepts instances of that class
     * @preconditions Route sends via plainDestination() which never calls tagAdapter
     * @expectedResult The mock handler runs; calls.send has one entry
     */
    test("intercepts adapters by constructor when the factory is not tagged", async () => {
      const mock = mockAdapter(PlainDestination, {
        send: async () => ({ ok: true, via: "mock" }),
      });

      const route = craft()
        .from(simple({ payload: 1 }))
        .to(plainDestination("primary"));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(mock.calls.send).toHaveLength(1);
      expect(mock.calls.send[0].result).toEqual({ ok: true, via: "mock" });
      expect(t.errors).toHaveLength(0);
    });

    /**
     * @case class-form mock and factory-form mock coexist on the same context
     * @preconditions Route uses both a plain destination and an http call
     * @expectedResult Each mock records only the calls that match its target
     */
    test("coexists with factory-form mocks on the same context", async () => {
      const plainMock = mockAdapter(PlainDestination, {
        send: async () => ({ ok: true }),
      });
      const httpMock = mockAdapter(http, {
        send: async () => ({
          status: 200,
          headers: {},
          body: {},
          url: "x",
        }),
      });

      const route = craft()
        .from(simple({ payload: 1 }))
        .tap(plainDestination("a"))
        .to(http({ url: "http://127.0.0.1:0/x", method: "GET" }));

      t = await testContext()
        .override(plainMock)
        .override(httpMock)
        .routes(route)
        .build();
      await t.test();

      expect(plainMock.calls.send).toHaveLength(1);
      expect(httpMock.calls.send).toHaveLength(1);
    });
  });

  describe("source behaviour shapes", () => {
    async function runWithSource<M>(
      behavior: NonNullable<MockAdapterBehavior<M>["source"]>,
    ): Promise<{ received: M[]; mock: AdapterMock }> {
      const received: M[] = [];
      const mock = mockAdapter<typeof PlainSource, M>(PlainSource, {
        source: behavior,
      });
      const route = craft()
        .from(plainSource<M>("src"))
        .to(async (ex: Exchange<M>) => {
          received.push(ex.body);
        });
      t = await testContext().override(mock).routes(route).build();
      await t.test();
      return { received, mock };
    }

    /**
     * @case source accepts a plain array of fixtures
     * @preconditions mock source is [1,2,3]
     * @expectedResult Route receives each element in order; yielded count is 3
     */
    test("accepts an array", async () => {
      const { received, mock } = await runWithSource<number>([1, 2, 3]);
      expect(received).toEqual([1, 2, 3]);
      expect(mock.calls.source).toHaveLength(1);
      expect(mock.calls.source[0].yielded).toBe(3);
    });

    /**
     * @case source accepts a function returning an array
     * @preconditions mock source is () => [10, 20]
     * @expectedResult Route receives [10, 20]
     */
    test("accepts a function returning an array", async () => {
      const { received } = await runWithSource<number>(() => [10, 20]);
      expect(received).toEqual([10, 20]);
    });

    /**
     * @case source accepts an async iterable
     * @preconditions mock source is an async generator yielding "a","b"
     * @expectedResult Route receives ["a", "b"]
     */
    test("accepts an async iterable", async () => {
      async function* gen(): AsyncGenerator<string> {
        yield "a";
        yield "b";
      }
      const { received } = await runWithSource<string>(gen());
      expect(received).toEqual(["a", "b"]);
    });
  });

  describe("error propagation", () => {
    /**
     * @case send handler throw surfaces as a context error and the call is still recorded
     * @preconditions send handler rejects
     * @expectedResult calls.send has one entry with result undefined; t.errors non-empty
     */
    test("records and propagates send errors", async () => {
      const mock = mockAdapter(PlainDestination, {
        send: async () => {
          throw new Error("boom");
        },
      });

      const route = craft()
        .from(simple({ payload: 1 }))
        .to(plainDestination("primary"));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(mock.calls.send).toHaveLength(1);
      expect(mock.calls.send[0].result).toBeUndefined();
      expect(t.errors.length).toBeGreaterThan(0);
      expect(String(t.errors[0])).toContain("boom");
    });

    /**
     * @case destination mock without a send handler silently no-ops and still records
     * @preconditions mockAdapter source-only on a destination-only route
     * @expectedResult calls.send has one entry with result undefined; no errors raised
     */
    test("destination without handler records a noop call", async () => {
      const mock = mockAdapter(PlainDestination, {}); // no source, no send

      const route = craft()
        .from(simple({ payload: 1 }))
        .to(plainDestination("primary"));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(mock.calls.send).toHaveLength(1);
      expect(mock.calls.send[0].result).toBeUndefined();
      expect(t.errors).toHaveLength(0);
    });
  });

  describe("override input forms", () => {
    /**
     * @case testContext().override() accepts a raw AdapterOverride without the mockAdapter wrapper
     * @preconditions A hand-built AdapterOverride is registered directly
     * @expectedResult The framework still intercepts the adapter and records the call
     */
    test("accepts a raw AdapterOverride", async () => {
      const rawOverride: AdapterOverride = {
        target: PlainDestination,
        calls: { source: [], send: [] },
        send: async () => ({ raw: true }),
      };

      const route = craft()
        .from(simple({ payload: 1 }))
        .to(plainDestination("primary"));

      t = await testContext().override(rawOverride).routes(route).build();
      await t.test();

      expect(rawOverride.calls.send).toHaveLength(1);
      expect(rawOverride.calls.send[0].result).toEqual({ raw: true });
    });
  });

  describe("recorded snapshot isolation", () => {
    /**
     * @case A send handler mutating exchange.body does not corrupt the recorded snapshot
     * @preconditions Route forwards an object body; the send handler mutates `exchange.body` after the call is recorded
     * @expectedResult calls.send[0].exchange.body still reflects the pre-mutation state
     */
    test("recorded exchange.body is isolated from later mutations", async () => {
      const mock = mockAdapter(PlainDestination, {
        send: async (exchange) => {
          // Mutate after the call has been recorded; the snapshot must not
          // reflect this change.
          (exchange.body as { mutated: boolean }).mutated = true;
          return { ok: true };
        },
      });

      const route = craft()
        .from(simple({ mutated: false, original: "kept" }))
        .to(plainDestination("primary"));

      t = await testContext().override(mock).routes(route).build();
      await t.test();

      expect(mock.calls.send).toHaveLength(1);
      const recorded = mock.calls.send[0].exchange.body as {
        mutated: boolean;
        original: string;
      };
      expect(recorded.mutated).toBe(false);
      expect(recorded.original).toBe("kept");
    });
  });

  describe("duplicate override detection", () => {
    /**
     * @case Registering two overrides for the same target throws at build-time
     * @preconditions Two mockAdapter handles share a target factory
     * @expectedResult The second `.override()` call throws with an actionable message
     */
    test("registering two mocks for the same factory throws", () => {
      const first = mockAdapter(http, { send: async () => ({}) });
      const second = mockAdapter(http, { send: async () => ({}) });

      const builder = testContext().override(first);
      expect(() => builder.override(second)).toThrow(/duplicate override/i);
    });

    /**
     * @case Duplicate detection also fires for class-form targets
     * @preconditions Two mockAdapter handles share an adapter class
     * @expectedResult The second `.override()` call throws
     */
    test("registering two mocks for the same class throws", () => {
      const first = mockAdapter(PlainDestination, {
        send: async () => ({ ok: true }),
      });
      const second = mockAdapter(PlainDestination, {
        send: async () => ({ ok: true }),
      });

      const builder = testContext().override(first);
      expect(() => builder.override(second)).toThrow(/duplicate override/i);
    });
  });

  describe("multi-role factory", () => {
    /**
     * @case one mockAdapter on a factory covers both source and destination call sites
     * @preconditions Route uses mail() as source (.from) and mail() as destination (.to)
     * @expectedResult Both calls.source and calls.send are populated
     */
    test("one factory mock covers source and destination call sites", async () => {
      const mailMock = mockAdapter(mail, {
        source: [
          {
            uid: 1,
            messageId: "<m1>",
            from: "a@b",
            to: "me@test",
            subject: "s",
            date: new Date(),
            flags: new Set<string>(),
            folder: "INBOX",
          },
        ],
        send: async () => ({
          messageId: "<sent>",
          accepted: ["x@y"],
          rejected: [],
          response: "250 OK",
        }),
      });

      const route = craft()
        .from(mail("INBOX", {}))
        .transform(() => ({ to: "x@y", subject: "s", text: "t" }))
        .to(mail());

      t = await testContext().override(mailMock).routes(route).build();
      await t.test();

      expect(mailMock.calls.source).toHaveLength(1);
      expect(mailMock.calls.source[0].yielded).toBe(1);
      expect(mailMock.calls.send).toHaveLength(1);
    });
  });

  describe("first-party adapter factory tagging", () => {
    /**
     * @case file() instances carry the factory tag so mockAdapter(file, ...) can resolve them
     * @preconditions file({ path }) constructs a Source+Destination adapter
     * @expectedResult The instance carries RC_ADAPTER_FACTORY === file and mockAdapter(file, ...).override.target === file
     */
    test("file() is tagged with its factory", () => {
      const adapter = file({ path: "/tmp/__never__.txt" });
      expect(readFactoryTag(adapter)).toBe(file);
      const mock = mockAdapter(file, { send: async () => undefined });
      expect(mock.override.target).toBe(file);
    });

    /**
     * @case csv() instances carry the factory tag so mockAdapter(csv, ...) can resolve them
     * @preconditions csv({ path }) constructs a Source+Destination adapter; peer is loaded lazily on subscribe/send so construction is safe
     * @expectedResult The instance carries RC_ADAPTER_FACTORY === csv and mockAdapter(csv, ...).override.target === csv
     */
    test("csv() is tagged with its factory", () => {
      const adapter = csv({ path: "/tmp/__never__.csv" });
      expect(readFactoryTag(adapter)).toBe(csv);
      const mock = mockAdapter(csv, { send: async () => undefined });
      expect(mock.override.target).toBe(csv);
    });

    /**
     * @case json() file-mode instances carry the factory tag; transformer-mode instances do not (resolver does not fire on transform)
     * @preconditions json({ path }) returns the file adapter; json({}) returns the transformer
     * @expectedResult File-mode instance is tagged with json; transformer-mode instance has no factory tag
     */
    test("json() is tagged in file mode only", () => {
      const fileAdapter = json({ path: "/tmp/__never__.json" });
      expect(readFactoryTag(fileAdapter)).toBe(json);

      const transformer = json({});
      expect(readFactoryTag(transformer)).toBeUndefined();

      const mock = mockAdapter(json, { send: async () => undefined });
      expect(mock.override.target).toBe(json);
    });

    /**
     * @case jsonl() instances carry the factory tag across all return paths
     * @preconditions jsonl({ path: string }) returns Source+Destination; jsonl({ path: fn }) returns Destination-only; jsonl({ path, chunked: true }) returns Source-only
     * @expectedResult Each return shape carries RC_ADAPTER_FACTORY === jsonl
     */
    test("jsonl() is tagged across return paths", () => {
      const combined = jsonl({ path: "/tmp/__never__.jsonl" });
      const destOnly = jsonl({ path: () => "/tmp/__never__.jsonl" });
      const sourceOnly = jsonl({ path: "/tmp/__never__.jsonl", chunked: true });

      expect(readFactoryTag(combined)).toBe(jsonl);
      expect(readFactoryTag(destOnly)).toBe(jsonl);
      expect(readFactoryTag(sourceOnly)).toBe(jsonl);

      const mock = mockAdapter(jsonl, { send: async () => undefined });
      expect(mock.override.target).toBe(jsonl);
    });

    /**
     * @case html() file-mode instances carry the factory tag; transformer-only instances do not
     * @preconditions html({ path, selector }) returns Transformer+Source+Destination; html({ selector }) returns transformer only
     * @expectedResult File-mode instance is tagged with html; transformer-only instance has no factory tag
     */
    test("html() is tagged in file mode only", () => {
      const fileAdapter = html({
        path: "/tmp/__never__.html",
        selector: "title",
        extract: "text",
      });
      expect(readFactoryTag(fileAdapter)).toBe(html);

      const transformer = html({ selector: "title", extract: "text" });
      expect(readFactoryTag(transformer)).toBeUndefined();

      const mock = mockAdapter(html, { send: async () => undefined });
      expect(mock.override.target).toBe(html);
    });

    /**
     * @case mockAdapter(file, { source }) actually intercepts a real .from(file(...)) at route execution time
     * @preconditions Route subscribes to file() pointed at a non-existent path; mock is registered with a fixture
     * @expectedResult Real filesystem read is bypassed; the spy destination receives the mock fixture
     */
    test("mockAdapter(file, { source }) intercepts a route built with the factory", async () => {
      const fileMock = mockAdapter<typeof file, string>(file, {
        source: ["mocked file body"],
      });
      const captured = spy<string>();

      const route = craft()
        .id("file-mock-smoke")
        .from(file({ path: "/tmp/__never_exists__/x.txt" }))
        .to(captured);

      t = await testContext().override(fileMock).routes(route).build();
      await t.test();

      expect(fileMock.calls.source).toHaveLength(1);
      expect(captured.received).toHaveLength(1);
      expect(captured.received[0].body).toBe("mocked file body");
      expect(t.errors).toHaveLength(0);
    });
  });
});
