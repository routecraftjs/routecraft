import { describe, expect, test } from "bun:test";
import {
  CraftContext,
  DefaultExchange,
  HeadersKeys,
  authenticate,
  authorize,
  isAuthentic,
  isRestored,
  type Exchange,
} from "../src/index.ts";
// The serializer is engine machinery, not public API: it is reached through
// the intra-package barrel the executor uses, not the package index.
import {
  DATE_TAG,
  deserializeExchange,
  serializeExchange,
} from "../src/suspension/index.ts";
// Not public API: the Secret brand is reserved for #526 and reachable only
// from inside the package, which is exactly the position the serializer's
// refusal has to be tested from.
import { BRAND, setBrand } from "../src/brand.ts";

const context = new CraftContext();

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

describe("suspension serialization", () => {
  /**
   * @case A parked exchange comes back the way it went in
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
   * @case JSON drops undefined object properties, so both backends must agree
   * @preconditions A body with an undefined property and an array hole
   * @expectedResult The property is absent and the array entry survives as null
   */
  test("applies JSON semantics to undefined consistently", () => {
    const serialized = serializeExchange(
      exchangeWith({ present: 1, absent: undefined, list: [1, undefined, 3] }),
    );

    const body = serialized.body as Record<string, unknown>;
    expect("absent" in body).toBe(false);
    expect(body["list"]).toEqual([1, undefined, 3]);
  });
});

describe("suspension serialization refusals", () => {
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
   * @case A secret must never reach the suspension store
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

describe("suspension serialization hostile input", () => {
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
   * @expectedResult RC5042 at suspend time, so the approver never signs off
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
   * @expectedResult RC5042, because parking successfully and losing the
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
    expect(isAuthentic(principal)).toBe(true);

    const revived = deserializeExchange(
      context,
      serializeExchange(
        exchangeWith({}, { [HeadersKeys.AUTH_PRINCIPAL]: principal }),
      ),
    );

    expect(revived.principal?.subject).toBe("user:jaco");
    expect(isRestored(revived.principal)).toBe(true);
    expect(isAuthentic(revived.principal)).toBe(false);
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
    expect(revived.principal).toBeUndefined();
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

    expect(isRestored(twice.principal)).toBe(true);
    expect(isAuthentic(twice.principal)).toBe(false);
  });
});
