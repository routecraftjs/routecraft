import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CraftContext,
  DefaultExchange,
  HeadersKeys,
  authenticate,
  authorize,
  defaultAuthority,
  type Exchange,
  principalOf,
} from "../src/index.ts";
import { isRestored } from "../src/auth/restored.ts";
// The serializer is engine machinery, not public API: it is reached through
// the intra-package barrel the executor uses, not the package index.
import {
  BUFFER_TAG,
  BYTES_TAG,
  DATE_TAG,
  decodeOutcome,
  deserializeExchange,
  detachPersistable,
  encodeOutcome,
  serializeExchange,
} from "../src/plugins/deferral/public.ts";
// Not public API: the Secret brand is reserved for #526 and reachable only
// from inside the package, which is exactly the position the serializer's
// refusal has to be tested from.
import { BRAND, setBrand } from "../src/brand.ts";

const context = new CraftContext();

// The restorer resolves the application's authority, which only an
// application with its plugins installed has.
beforeAll(() => context.initPlugins());
afterAll(() => context.stop());

function exchangeWith(
  body: unknown,
  headers: Record<string, unknown> = {},
): Exchange {
  return new DefaultExchange(context, {
    body,
    headers: {
      "routecraft.id": "ex-1",
      "routecraft.route": "payout",
      ...headers,
    },
  });
}

describe("deferral serialization", () => {
  /**
   * @case A deferred exchange comes back the way it went in
   * @preconditions An exchange with a nested body and custom headers
   * @expectedResult Body and headers round-trip field for field
   */
  test("round-trips body and headers", () => {
    const source = exchangeWith(
      { amountCents: 75_000, lines: [{ sku: "a", qty: 2 }], memo: null },
      { "x-tenant": "acme" },
    );

    const revived = deserializeExchange(context, serializeExchange(source));

    expect(revived.body).toEqual(source.body);
    expect(revived.headers["x-tenant"]).toBe("acme");
    expect(revived.id).toBe("ex-1");
  });

  /**
   * @case Only the two stored slots cross the boundary
   * @preconditions Any exchange
   * @expectedResult The serialized form has exactly body and headers, so
   *   the persistence surface cannot drift from the exchange state model
   */
  test("persists exactly body and headers", () => {
    expect(Object.keys(serializeExchange(exchangeWith({})))).toEqual([
      "body",
      "headers",
    ]);
  });

  /**
   * @case A timestamp in the body is still a Date after days in a store
   * @preconditions A body holding a Date
   * @expectedResult The revived value is a Date with the same instant, not
   *   a string wearing its clothes
   */
  test("preserves Date values through the store", () => {
    const at = new Date("2026-08-10T09:00:00.000Z");

    const revived = deserializeExchange(
      context,
      serializeExchange(exchangeWith({ receivedAt: at })),
    );

    const value = (revived.body as { receivedAt: Date }).receivedAt;
    expect(value).toBeInstanceOf(Date);
    expect(value.getTime()).toBe(at.getTime());
  });

  /**
   * @case Raw bytes survive the store byte for byte
   * @preconditions A body holding a Buffer and a header holding another,
   *   as a mail attachment or a file read leaves them
   * @expectedResult Both come back as a Buffer with the same bytes, and the
   *   stored form is the base64 envelope rather than the Buffer itself
   */
  test("preserves Buffer values through the store", () => {
    const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
    const stamp = Buffer.from("sig");
    const stored = serializeExchange(
      exchangeWith({ attachment: { content: payload } }, { "x-sig": stamp }),
    );

    expect(stored.body).toEqual({
      attachment: { content: { [BUFFER_TAG]: payload.toString("base64") } },
    });

    const revived = deserializeExchange(context, stored);
    const content = (revived.body as { attachment: { content: unknown } })
      .attachment.content;
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content).toEqual(payload);
    // Its own ArrayBuffer, not a window on Node's shared decode pool.
    expect((content as Buffer).buffer.byteLength).toBe(payload.byteLength);
    expect(revived.headers["x-sig"]).toEqual(stamp);
  });

  /**
   * @case A plain Uint8Array comes back a plain Uint8Array
   * @preconditions A body holding a Uint8Array, as an HTTP binary body is
   * @expectedResult The stored form is the bytes envelope, distinct from the
   *   Buffer one, and the revived value has Uint8Array's own prototype with
   *   the same bytes: it stringifies, slices and JSON-renders as it did
   *   before the defer
   */
  test("revives a Uint8Array as a Uint8Array", () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const stored = serializeExchange(exchangeWith({ bytes }));
    expect(stored.body).toEqual({ bytes: { [BYTES_TAG]: "BwgJ" } });

    const revived = deserializeExchange(context, stored);
    const out = (revived.body as { bytes: Uint8Array }).bytes;
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(Array.from(out)).toEqual([7, 8, 9]);
    // Its own ArrayBuffer, not a window on Node's shared decode pool.
    expect(out.buffer.byteLength).toBe(3);
  });

  /**
   * @case A view persists only its own window
   * @preconditions A subarray over a larger Buffer, and a Buffer over the
   *   middle of an ArrayBuffer that holds other bytes on both sides, as a
   *   pooled allocation does
   * @expectedResult Each revives as exactly its own bytes, with nothing
   *   from the surrounding ArrayBuffer
   */
  test("persists a byte view by its window, not its backing buffer", () => {
    const whole = Buffer.from("0123456789");
    const view = whole.subarray(3, 6);
    const backing = new Uint8Array(Buffer.from("xxxxtinyxxxx")).buffer;
    const pooled = Buffer.from(backing, 4, 4);
    expect(pooled.buffer.byteLength).toBe(12);

    const revived = deserializeExchange(
      context,
      serializeExchange(exchangeWith({ view, pooled })),
    );
    const body = revived.body as { view: Buffer; pooled: Buffer };
    expect(body.view.toString()).toBe("345");
    expect(body.pooled.toString()).toBe("tiny");
    expect(body.pooled.byteLength).toBe(4);
  });

  /**
   * @case The store never holds a reference into a live exchange
   * @preconditions A serialized exchange whose source body is then mutated
   * @expectedResult The serialized copy is unchanged
   */
  test("detaches the serialized copy from the live exchange", () => {
    const body = { amountCents: 100 };
    const serialized = serializeExchange(exchangeWith(body));

    body.amountCents = 999;

    expect((serialized.body as { amountCents: number }).amountCents).toBe(100);
  });

  /**
   * @case Both backends must agree on what JSON cannot carry
   * @preconditions A body with an undefined property and an undefined array entry
   * @expectedResult The property is dropped and the array entry becomes null,
   *   which is what a JSON round trip does, so a deployment on the sqlite
   *   backend and one that fell back to memory see the same value
   */
  test("applies JSON semantics to undefined consistently", () => {
    const serialized = serializeExchange(
      exchangeWith({ present: 1, absent: undefined, list: [1, undefined, 3] }),
    );

    const body = serialized.body as Record<string, unknown>;
    expect("absent" in body).toBe(false);
    expect(body["list"]).toEqual([1, null, 3]);
    // The normalized form is a fixed point of a JSON round trip, which is
    // what makes the two backends interchangeable.
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  /**
   * @case An array hole is not a value the backends can disagree about
   * @preconditions A sparse array in the body
   * @expectedResult The hole becomes null rather than surviving as a hole
   */
  test("normalizes array holes to null", () => {
    // Built rather than written as `[1, , 3]`: a literal hole is a lint
    // error, and the point is the hole, not how it was created.
    const sparse: unknown[] = [1];
    sparse.length = 2;
    sparse.push(3);
    const serialized = serializeExchange(exchangeWith({ list: sparse }));
    expect((serialized.body as { list: unknown[] }).list).toEqual([1, null, 3]);
  });
});

describe("detached live copies", () => {
  /**
   * @case A live copy keeps every admitted kind as itself
   * @preconditions A value holding a Date, a Buffer, a Uint8Array, a nested
   *   object and an array
   * @expectedResult The copy carries a new Date with the same instant, a
   *   Buffer and a Uint8Array with the same bytes on their own ArrayBuffers,
   *   ordinary-prototype objects and arrays, and shares nothing with the
   *   source
   */
  test("detachPersistable copies in live form", () => {
    const when = new Date("2026-05-01T09:00:00.000Z");
    const receipt = Buffer.from("paid");
    const bytes = new Uint8Array([1, 2, 3]);
    const source = { when, receipt, bytes, lines: [{ n: 1 }] };

    const copy = detachPersistable(source, "terminal body") as typeof source;

    expect(copy).not.toBe(source);
    expect(copy.when).toBeInstanceOf(Date);
    expect(copy.when).not.toBe(when);
    expect(copy.when.getTime()).toBe(when.getTime());
    expect(Buffer.isBuffer(copy.receipt)).toBe(true);
    expect(copy.receipt).not.toBe(receipt);
    expect(copy.receipt.toString()).toBe("paid");
    expect(copy.receipt.buffer.byteLength).toBe(4);
    expect(Object.getPrototypeOf(copy.bytes)).toBe(Uint8Array.prototype);
    expect(Array.from(copy.bytes)).toEqual([1, 2, 3]);
    expect(copy.bytes.buffer).not.toBe(bytes.buffer);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.lines).not.toBe(source.lines);
    expect(copy.lines[0]).toEqual({ n: 1 });
  });

  /**
   * @case A live copy is held to the same rules as the wire form
   * @preconditions A value holding a function, and one shaped like a
   *   reserved envelope
   * @expectedResult RC5042 for both, naming the path
   */
  test("detachPersistable refuses what encodePersistable refuses", () => {
    expect(() => detachPersistable({ run: () => 1 }, "terminal body")).toThrow(
      expect.objectContaining({
        rc: "RC5042",
        message: expect.stringContaining("terminal body.run"),
      }),
    );
    expect(() =>
      detachPersistable({ blob: { [BYTES_TAG]: "AAAA" } }, "terminal body"),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
  });

  /**
   * @case An outcome's terminal body is the one slot that crosses the encoder
   * @preconditions A completed outcome whose body holds a Date and a Buffer
   * @expectedResult encodeOutcome leaves status and at alone and encodes the
   *   body into envelopes; decodeOutcome revives it; an outcome with no body
   *   passes through both unchanged
   */
  test("encodeOutcome and decodeOutcome round-trip the body slot", () => {
    const at = new Date("2026-05-01T10:00:00.000Z");
    const when = new Date("2026-05-01T09:00:00.000Z");
    const outcome = {
      status: "completed" as const,
      body: { when, receipt: Buffer.from("paid") },
      at,
    };

    const stored = encodeOutcome(outcome);
    expect(stored.at).toBe(at);
    expect(stored.body).toEqual({
      when: { [DATE_TAG]: when.toISOString() },
      receipt: { [BUFFER_TAG]: Buffer.from("paid").toString("base64") },
    });

    const revived = decodeOutcome(stored).body as {
      when: Date;
      receipt: Buffer;
    };
    expect(revived.when.getTime()).toBe(when.getTime());
    expect(revived.receipt.toString()).toBe("paid");

    const bodiless = { status: "dropped" as const, reason: "no", at };
    expect(encodeOutcome(bodiless)).toBe(bodiless);
    expect(decodeOutcome(bodiless)).toBe(bodiless);
  });

  /**
   * @case A corrupted stored outcome names its slot
   * @preconditions A stored outcome whose body holds a date envelope that
   *   does not parse
   * @expectedResult RC5042 whose message names continuation.body rather
   *   than the exchange
   */
  test("decodeOutcome refuses a corrupted body naming the slot", () => {
    expect(() =>
      decodeOutcome({
        status: "completed",
        body: { when: { [DATE_TAG]: "not-a-date" } },
        at: new Date(),
      }),
    ).toThrow(
      expect.objectContaining({
        rc: "RC5042",
        message: expect.stringContaining("continuation.body"),
      }),
    );
  });
});

describe("deferral serialization refusals", () => {
  /**
   * @case A live resolver cannot be written to the store
   * @preconditions A body holding a function, which is the shape a Blocks
   *   record with unresolved resolvers takes
   * @expectedResult RC5042, naming the path that failed
   */
  test("refuses a function", () => {
    expect(() =>
      serializeExchange(exchangeWith({ resolve: () => "value" })),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(() =>
      serializeExchange(exchangeWith({ resolve: () => "value" })),
    ).toThrow(/body\.resolve/);
  });

  /**
   * @case A secret must never reach the deferral store
   * @preconditions A body holding a value carrying the reserved Secret brand
   * @expectedResult RC5042, so the rule holds the moment #526 brands Secret
   */
  test("refuses a branded Secret", () => {
    const secret = { revealed: "hunter2" };
    setBrand(secret, BRAND.Secret);

    expect(() => serializeExchange(exchangeWith({ token: secret }))).toThrow(
      expect.objectContaining({ rc: "RC5042" }),
    );
  });

  /**
   * @case A cycle fails with a legible error rather than a JSON stack trace
   * @preconditions A body that references itself
   * @expectedResult RC5042 naming the circular path
   */
  test("refuses a circular reference", () => {
    const body: Record<string, unknown> = { name: "loop" };
    body["self"] = body;

    expect(() => serializeExchange(exchangeWith(body))).toThrow(
      expect.objectContaining({ rc: "RC5042" }),
    );
  });

  /**
   * @case A class instance would come back as a different animal
   * @preconditions A body holding an adapter client
   * @expectedResult RC5042 naming the class, so the author can move it out
   *   of the exchange rather than discovering a broken method after resume
   */
  test("refuses a class instance", () => {
    class ImapClient {
      readonly host = "mail.example";
      connect(): void {}
    }

    expect(() =>
      serializeExchange(exchangeWith({ client: new ImapClient() })),
    ).toThrow(/ImapClient/);
  });

  /**
   * @case Values JSON would silently rewrite are refused instead
   * @preconditions Bodies holding NaN, Infinity, a bigint and a symbol
   * @expectedResult Each throws RC5042 rather than round-tripping as null
   */
  test("refuses values JSON cannot carry faithfully", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("s"),
    ]) {
      expect(() => serializeExchange(exchangeWith({ value }))).toThrow(
        expect.objectContaining({ rc: "RC5042" }),
      );
    }
  });

  /**
   * @case A decorated Date would lose its extra state in silence
   * @preconditions A Date carrying an own property
   * @expectedResult RC5042, because the envelope keeps only the instant and
   *   the property would be gone after resume with no signal
   */
  test("refuses a Date carrying extra properties", () => {
    const decorated = Object.assign(new Date("2026-08-10T09:00:00.000Z"), {
      timezone: "Europe/Amsterdam",
    });

    expect(() => serializeExchange(exchangeWith({ at: decorated }))).toThrow(
      expect.objectContaining({ rc: "RC5042" }),
    );
  });

  /**
   * @case A hidden field on a Date is refused, not dropped
   * @preconditions A Date whose own property is non-enumerable
   * @expectedResult RC5042. A non-enumerable field is lost through the
   *   envelope just as silently as an enumerable one, so the check cannot
   *   stop at `Object.keys`.
   */
  test("refuses a Date carrying a non-enumerable property", () => {
    const decorated = new Date("2026-08-10T09:00:00.000Z");
    Object.defineProperty(decorated, "timezone", {
      value: "Europe/Amsterdam",
      enumerable: false,
    });

    expect(() => serializeExchange(exchangeWith({ at: decorated }))).toThrow(
      expect.objectContaining({ rc: "RC5042" }),
    );
  });

  /**
   * @case A Date subclass is refused rather than downgraded
   * @preconditions A subclass instance carrying behaviour on its prototype
   * @expectedResult RC5042, because the envelope holds an instant and the
   *   value would resume as a plain Date with that behaviour gone
   */
  test("refuses a Date subclass", () => {
    class BusinessDate extends Date {
      get quarter(): number {
        return Math.floor(this.getMonth() / 3) + 1;
      }
    }

    const attempt = () =>
      serializeExchange(
        exchangeWith({ at: new BusinessDate("2026-08-10T09:00:00.000Z") }),
      );

    expect(attempt).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(attempt).toThrow(/BusinessDate/);
  });

  /**
   * @case A byte array subclass is refused like any other class instance
   * @preconditions A body holding an instance of a class extending
   *   Uint8Array, with a method of its own
   * @expectedResult RC5042, because the envelope keeps the bytes only and
   *   the subclass would resume as a plain Buffer with its behaviour gone
   */
  test("refuses a byte array subclass", () => {
    class Signed extends Uint8Array {
      verify(): boolean {
        return true;
      }
    }
    expect(() =>
      serializeExchange(exchangeWith({ bytes: new Signed([1]) })),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
  });

  /**
   * @case Typed arrays of another element type are refused
   * @preconditions A body holding a Float32Array
   * @expectedResult RC5042 naming the class, since the byte envelope cannot
   *   say what element type to revive
   */
  test("refuses a typed array that is not bytes", () => {
    expect(() =>
      serializeExchange(exchangeWith({ samples: new Float32Array([0.5]) })),
    ).toThrow(
      expect.objectContaining({
        rc: "RC5042",
        message: expect.stringContaining("Float32Array"),
      }),
    );
  });

  /**
   * @case A byte array carrying a symbol-keyed property is refused
   * @preconditions A Buffer with a symbol-keyed own property riding on it
   * @expectedResult RC5042 naming the symbol-keyed property, rather than
   *   deferring and losing it
   */
  test("refuses a byte array carrying a symbol-keyed property", () => {
    const bytes = Buffer.from("x") as Buffer & Record<symbol, unknown>;
    bytes[Symbol("origin")] = "scan";
    expect(() => serializeExchange(exchangeWith({ bytes }))).toThrow(
      expect.objectContaining({
        rc: "RC5042",
        message: expect.stringContaining("symbol-keyed"),
      }),
    );
  });

  /**
   * @case A large byte array round-trips without scanning its indices
   * @preconditions A 10 MB Buffer, and a small one with a string-keyed own
   *   property hung on it
   * @expectedResult The large one serializes in well under a second, which
   *   an own-names scan (one string per byte) cannot do, and revives byte
   *   for byte; the small one's property is not carried, the recorded cost
   *   of skipping that scan
   */
  test("serializes a large byte array without enumerating its indices", () => {
    const large = Buffer.alloc(10 * 1024 * 1024, 1);
    const started = performance.now();
    const stored = serializeExchange(exchangeWith({ large }));
    expect(performance.now() - started).toBeLessThan(1000);
    // And back: a regex over the envelope overflowed Node's stack and
    // answered false on Bun at this size, so the round trip is the test.
    const back = (
      deserializeExchange(context, stored).body as { large: Buffer }
    ).large;
    expect(back.byteLength).toBe(large.byteLength);
    expect(back.equals(large)).toBe(true);

    const tagged = Buffer.from("x") as Buffer & { origin?: string };
    tagged.origin = "scan";
    const revived = deserializeExchange(
      context,
      serializeExchange(exchangeWith({ tagged })),
    );
    const out = (revived.body as { tagged: Buffer & { origin?: string } })
      .tagged;
    expect(out.toString()).toBe("x");
    expect(out.origin).toBeUndefined();
  });

  /**
   * @case State hidden on an array is refused, not dropped
   * @preconditions An array carrying a named property, which the index walk
   *   cannot see
   * @expectedResult RC5042 naming the property
   */
  test("refuses an array with a named property", () => {
    const list = Object.assign([1, 2], { cursor: "abc" });
    const attempt = () => serializeExchange(exchangeWith({ list }));

    expect(attempt).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(attempt).toThrow(/cursor/);
  });

  /**
   * @case A hidden field on an array is refused, not dropped
   * @preconditions An array whose named property is non-enumerable
   * @expectedResult RC5042. Same reasoning as the Date case: the index walk
   *   never visits it and `Object.keys` never reports it, so it would be
   *   gone after resume with nothing raised.
   */
  test("refuses an array with a non-enumerable named property", () => {
    const list: unknown[] = [1, 2];
    Object.defineProperty(list, "cursor", {
      value: "abc",
      enumerable: false,
    });
    const attempt = () => serializeExchange(exchangeWith({ list }));

    expect(attempt).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(attempt).toThrow(/cursor/);
  });

  /**
   * @case A digit-shaped key that is not an index is still a named property
   * @preconditions An array carrying `"01"`, which passes a digit test but is
   *   never visited by the index walk
   * @expectedResult RC5042 naming the key, rather than the value vanishing
   */
  test("refuses an array with a digit-shaped named property", () => {
    const list: unknown[] = [1, 2];
    (list as unknown as Record<string, unknown>)["01"] = "hidden";
    const attempt = () => serializeExchange(exchangeWith({ list }));

    expect(attempt).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(attempt).toThrow(/01/);
  });

  /**
   * @case A hidden field on a plain object is refused, not dropped
   * @preconditions A body object whose own property is non-enumerable
   * @expectedResult RC5042. Completes the rule the Date and array branches
   *   already hold: hidden own state is refused wherever it appears, because
   *   JSON drops a non-enumerable property as silently as a symbol-keyed one.
   */
  test("refuses an object with a non-enumerable property", () => {
    const body: Record<string, unknown> = { amountCents: 100 };
    Object.defineProperty(body, "auditToken", {
      value: "abc",
      enumerable: false,
    });
    const attempt = () => serializeExchange(exchangeWith(body));

    expect(attempt).toThrow(expect.objectContaining({ rc: "RC5042" }));
    expect(attempt).toThrow(/auditToken/);
  });

  /**
   * @case The check reaches into headers, not just the body
   * @preconditions A header holding an adapter handle
   * @expectedResult RC5042 naming the header path
   */
  test("checks headers as well as the body", () => {
    expect(() =>
      serializeExchange(exchangeWith({}, { "x-handle": () => undefined })),
    ).toThrow(/headers\.x-handle/);
  });
});

describe("deferral serialization hostile input", () => {
  /**
   * @case A body field named __proto__ survives the round trip intact
   * @preconditions A body parsed from JSON carrying a literal __proto__ key,
   *   which is a legal field name an external system can choose
   * @expectedResult The field is a normal own property on the serialized
   *   copy and the copy's prototype is untouched, rather than the value
   *   being swallowed by the inherited setter and lost after resume
   */
  test("does not let __proto__ hijack the serialized copy", () => {
    const hostile = JSON.parse('{"amount":10,"__proto__":{"admin":true}}');

    const serialized = serializeExchange(exchangeWith(hostile));

    const body = serialized.body as Record<string, unknown>;
    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect((body as { admin?: boolean }).admin).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))["amount"]).toBe(10);
  });

  /**
   * @case The same key cannot hijack the revived exchange either
   * @preconditions A stored form carrying __proto__
   * @expectedResult The revived body keeps it as an own property and does
   *   not inherit from it
   */
  test("does not let __proto__ hijack the revived exchange", () => {
    const hostile = JSON.parse('{"__proto__":{"admin":true}}');

    const revived = deserializeExchange(
      context,
      serializeExchange(exchangeWith(hostile)),
    );

    expect((revived.body as { admin?: boolean }).admin).toBeUndefined();
    expect(Object.hasOwn(revived.body as object, "__proto__")).toBe(true);
  });

  /**
   * @case Body data cannot forge the Date envelope
   * @preconditions A body field shaped exactly like the internal Date
   *   envelope, which attacker-influenced JSON can be
   * @expectedResult RC5042 at defer time, so the approver never signs off
   *   on a payload that changes type on the way back
   */
  test("refuses a body that forges the Date envelope", () => {
    expect(() =>
      serializeExchange(
        exchangeWith({ when: { [DATE_TAG]: "2020-01-01T00:00:00.000Z" } }),
      ),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
  });

  /**
   * @case A byte array over a transferred ArrayBuffer is refused by name
   * @preconditions A Uint8Array whose backing ArrayBuffer was detached by a
   *   transfer, as a worker handoff leaves it
   * @expectedResult RC5042 naming the path, not the bare TypeError
   *   Buffer.from would throw
   */
  test("refuses a byte array over a detached ArrayBuffer", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    expect(() => serializeExchange(exchangeWith({ bytes }))).toThrow(
      expect.objectContaining({
        rc: "RC5042",
        message: expect.stringContaining(
          "body.bytes holds a byte array over a detached",
        ),
      }),
    );
  });

  /**
   * @case An envelope cannot be forged behind a dropped undefined sibling
   * @preconditions A body field shaped like an envelope plus one sibling
   *   whose value is undefined, which the walk drops, as a route that
   *   spreads inbound JSON into an object with an optional field produces
   * @expectedResult RC5042 at defer time for every tag, since what would be
   *   stored is the bare envelope
   */
  test("refuses a forged envelope hidden behind an undefined sibling", () => {
    for (const [tag, text] of [
      [DATE_TAG, "2020-01-01T00:00:00.000Z"],
      [BUFFER_TAG, "AAAA"],
      [BYTES_TAG, "AAAA"],
    ] as const) {
      expect(() =>
        serializeExchange(
          exchangeWith({ blob: { [tag]: text, gone: undefined } }),
        ),
      ).toThrow(expect.objectContaining({ rc: "RC5042" }));
    }
  });

  /**
   * @case Body data cannot forge either bytes envelope
   * @preconditions A body field shaped exactly like the internal buffer or
   *   bytes envelope, which attacker-influenced JSON can be
   * @expectedResult RC5042 at defer time for each, so a string never changes
   *   into bytes on the way back
   */
  test("refuses a body that forges a bytes envelope", () => {
    for (const tag of [BUFFER_TAG, BYTES_TAG]) {
      expect(() =>
        serializeExchange(exchangeWith({ blob: { [tag]: "AAAA" } })),
      ).toThrow(expect.objectContaining({ rc: "RC5042" }));
    }
  });

  /**
   * @case A corrupted stored bytes envelope fails loudly
   * @preconditions A stored form whose bytes envelope is not base64, which
   *   Buffer.from would decode to fewer bytes without an error
   * @expectedResult RC5042 rather than truncated bytes handed to the route
   */
  test("refuses an unparseable stored bytes envelope", () => {
    for (const tag of [BUFFER_TAG, BYTES_TAG]) {
      expect(() =>
        deserializeExchange(context, {
          body: { blob: { [tag]: "not base64!" } },
          headers: { "routecraft.id": "ex-1" },
        }),
      ).toThrow(expect.objectContaining({ rc: "RC5042" }));
    }
  });

  /**
   * @case A corrupted stored envelope fails loudly
   * @preconditions A stored form whose date envelope does not parse
   * @expectedResult RC5042 rather than an Invalid Date handed to the route
   */
  test("refuses an unparseable stored date envelope", () => {
    expect(() =>
      deserializeExchange(context, {
        body: { when: { [DATE_TAG]: "not-a-date" } },
        headers: { "routecraft.id": "ex-1" },
      }),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
  });

  /**
   * @case Symbol-keyed state is refused, not silently discarded
   * @preconditions A body carrying a symbol-keyed property, which is the
   *   framework's own idiom for attaching state
   * @expectedResult RC5042, because deferring successfully and losing the
   *   data is the failure mode the whole walk exists to prevent
   */
  test("refuses a symbol-keyed property", () => {
    expect(() =>
      serializeExchange(exchangeWith({ visible: 1, [Symbol("handle")]: 2 })),
    ).toThrow(expect.objectContaining({ rc: "RC5042" }));
  });
});

describe("restored principals", () => {
  /**
   * @case A principal read off disk is not a verified one
   * @preconditions An authentic principal is serialized and revived
   * @expectedResult The revived principal is restored, never authentic
   */
  test("marks a rehydrated principal restored rather than authentic", () => {
    const principal = authenticate({ subject: "user:jaco", roles: ["admin"] });
    expect(defaultAuthority.isAuthentic(principal)).toBe(true);

    const revived = deserializeExchange(
      context,
      serializeExchange(
        exchangeWith({}, { [HeadersKeys.AUTH_PRINCIPAL]: principal }),
      ),
    );

    expect(principalOf(revived)?.subject).toBe("user:jaco");
    expect(isRestored(principalOf(revived))).toBe(true);
    expect(defaultAuthority.isAuthentic(principalOf(revived))).toBe(false);
  });

  /**
   * @case A restored principal cannot authorize on its own
   * @preconditions A resumed exchange whose principal carries the right role
   * @expectedResult authorize() rejects with RC5043, distinct from RC5023,
   *   because the fix is to re-verify rather than to mint
   */
  test("authorize() rejects a restored principal with its own code", () => {
    const revived = deserializeExchange(
      context,
      serializeExchange(
        exchangeWith(
          {},
          {
            [HeadersKeys.AUTH_PRINCIPAL]: authenticate({
              subject: "user:jaco",
              roles: ["admin"],
            }),
          },
        ),
      ),
    );

    expect(() => authorize({ roles: ["admin"] })(revived)).toThrow(
      expect.objectContaining({ rc: "RC5043" }),
    );
  });

  /**
   * @case An exchange with no principal survives the round trip untouched
   * @preconditions An exchange carrying no principal header
   * @expectedResult No principal is invented on the way back
   */
  test("leaves an exchange without a principal alone", () => {
    const revived = deserializeExchange(
      context,
      serializeExchange(exchangeWith({ amountCents: 1 })),
    );
    expect(principalOf(revived)).toBeUndefined();
  });

  /**
   * @case Marking is idempotent
   * @preconditions A principal revived twice through two round trips
   * @expectedResult It stays restored and never becomes authentic
   */
  test("stays restored across repeated round trips", () => {
    const once = deserializeExchange(
      context,
      serializeExchange(
        exchangeWith(
          {},
          { [HeadersKeys.AUTH_PRINCIPAL]: authenticate({ subject: "s" }) },
        ),
      ),
    );
    const twice = deserializeExchange(context, serializeExchange(once));

    expect(isRestored(principalOf(twice))).toBe(true);
    expect(defaultAuthority.isAuthentic(principalOf(twice))).toBe(false);
  });
});
