import { describe, test, expect, afterEach } from "vitest";
import {
  craft,
  simple,
  http,
  mail,
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
  type AdapterMock,
  type MockAdapterBehavior,
  type TestContext,
} from "@routecraft/testing";

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
});
