import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  HeadersKeys,
  simple,
  type Exchange,
  type Principal,
} from "@routecraft/routecraft";

describe("Exchange state model", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Stored state is exactly { body, headers } (the halt/continue contract)
   * @preconditions A DefaultExchange constructed inside a route, with id and principal both set via headers
   * @expectedResult Only `body` and `headers` appear as own enumerable properties; `id`, `principal`, `logger` are getters on the prototype
   */
  test("only body and headers are own enumerable properties", async () => {
    let captured: Exchange | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("state-model-shape")
          .from(simple("hello"))
          .process((ex) => {
            captured = ex;
            return ex;
          })
          .to(() => undefined),
      )
      .build();

    await t.test();

    expect(captured).toBeDefined();
    const ownKeys = Object.keys(captured!).sort();
    // Symbol-keyed internals slot is not an enumerable property, so it
    // does not appear in Object.keys.
    expect(ownKeys).toEqual(["body", "headers"]);
    // The derived accessors are still readable on the public type.
    expect(typeof captured!.id).toBe("string");
    expect(typeof captured!.logger).toBe("object");
  });

  /**
   * @case Halt/continue contract: { body, headers } is sufficient to rehydrate an exchange
   * @preconditions Take a constructed exchange's body+headers, JSON round-trip them, reconstruct via new DefaultExchange
   * @expectedResult The rehydrated exchange exposes the original id and principal through its getters
   */
  test("rehydrates correctly from JSON-serialized { body, headers }", async () => {
    let original: Exchange | undefined;
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["admin"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("rehydrate-source")
          .from(simple("payload"))
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .process((ex) => {
            original = ex;
            return ex;
          })
          .to(() => undefined),
      )
      .build();

    await t.test();

    expect(original).toBeDefined();
    const originalId = original!.id;

    // Serialize the persistable surface and rehydrate. This is exactly
    // what halt/continue would do across a process boundary.
    const wirePayload = JSON.parse(
      JSON.stringify({
        body: original!.body,
        headers: original!.headers,
      }),
    );

    const rehydrated = new DefaultExchange(t.ctx, {
      body: wirePayload.body,
      headers: wirePayload.headers,
    });

    expect(rehydrated.body).toBe("payload");
    // id flows through headers, so it survives the round-trip.
    expect(rehydrated.id).toBe(originalId);
    expect(rehydrated.headers[HeadersKeys.ID]).toBe(originalId);
    // Principal is reconstructed by the getter from the rehydrated header.
    expect(rehydrated.principal).toEqual(principal);
    // Logger is regenerated lazily; the rehydrated exchange must still
    // produce a usable child logger without the original's runtime services.
    expect(typeof rehydrated.logger).toBe("object");
    expect(typeof rehydrated.logger.info).toBe("function");
  });

  /**
   * @case Constructor accepts headers carrying both id and principal
   * @preconditions Build a DefaultExchange directly with headers including id and principal
   * @expectedResult The id getter returns the supplied id; the principal getter returns the supplied principal
   */
  test("id and principal are read from headers via getters", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("getter-readback")
          .from(simple("noop"))
          .to(() => undefined),
      )
      .build();

    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "alice",
    };
    const ex = new DefaultExchange(t.ctx, {
      body: { hello: "world" },
      headers: {
        "routecraft.id": "fixed-id-123",
        "routecraft.auth.principal": principal,
        "routecraft.route": "getter-readback",
      },
    });

    expect(ex.id).toBe("fixed-id-123");
    expect(ex.principal).toEqual(principal);
    expect(ex.headers["routecraft.id"]).toBe("fixed-id-123");
    expect(ex.headers["routecraft.auth.principal"]).toEqual(principal);
  });

  /**
   * @case Type-level: registered headers preserve their narrow types when
   *       indexed by literal key, while unregistered keys widen to
   *       `unknown` (the bag-level `HeaderValue`). Locks the contract that
   *       widening `HeaderValue` to `unknown` did not regress reads of
   *       registered headers; future refactors of `ExchangeHeaders` must
   *       not collapse this distinction.
   * @preconditions A reference to `Exchange<unknown>` declared via type-only
   * @expectedResult `routecraft.route` reads as `string | undefined`,
   *                 `routecraft.timer.counter` as `number | undefined`,
   *                 `routecraft.split_hierarchy` as `readonly string[] |
   *                 undefined`, and an arbitrary key as `unknown`
   */
  test("registered header reads preserve narrow types; unknown keys widen to unknown", () => {
    type H = Exchange["headers"];
    expectTypeOf<H["routecraft.route"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<H[typeof HeadersKeys.CORRELATION_ID]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<H["routecraft.timer.counter"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<H["routecraft.split_hierarchy"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf<H["routecraft.auth.principal"]>().toEqualTypeOf<
      Principal | undefined
    >();
    // Unregistered keys widen to `unknown` (the bag-level catch-all).
    expectTypeOf<H["my.custom.unregistered"]>().toEqualTypeOf<unknown>();
  });

  /**
   * @case A constructor without an id-in-headers generates a fresh UUID
   * @preconditions DefaultExchange built without supplying routecraft.id in headers
   * @expectedResult ex.id is a non-empty string and matches headers["routecraft.id"]
   */
  test("generates a fresh id when headers omit routecraft.id", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("auto-id")
          .from(simple("noop"))
          .to(() => undefined),
      )
      .build();

    const ex = new DefaultExchange(t.ctx, { body: 1 });

    expect(typeof ex.id).toBe("string");
    expect(ex.id).toBeTruthy();
    expect(ex.id).toBe(ex.headers["routecraft.id"] as string);
  });
});
