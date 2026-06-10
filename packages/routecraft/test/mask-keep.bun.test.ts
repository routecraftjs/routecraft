import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "bun:test";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  HeadersKeys,
  keep,
  markAuthentic,
  mask,
  type CallableTransformer,
  type Exchange,
  type Principal,
  type Source,
} from "../src/index.ts";

interface Rec {
  id: string;
  email: string;
  yearlyWage?: number;
  internalNotes?: string;
  debug?: string;
  review?: { rating: number; note: string };
  card?: { number: string };
}

let t: TestContext;

beforeAll(async () => {
  t = await testContext()
    .routes(craft().id("ctx").from(craftSimple()).to(spy()))
    .build();
});

afterAll(async () => {
  if (t) await t.stop();
});

/** Minimal one-shot source so the shared context has a valid route. */
function craftSimple(): Source<string> {
  return { subscribe: async (sub) => void (await sub.emit({ message: "x" })) };
}

/** Build an exchange carrying an optional principal, for direct helper calls. */
function mk<T>(body: T, principal?: Principal): Exchange<T> {
  return new DefaultExchange<T>(t.ctx, {
    body,
    ...(principal
      ? { headers: { [HeadersKeys.AUTH_PRINCIPAL]: principal } }
      : {}),
  });
}

// keep trusts only authentic principals, so brand the test principal the way a
// source verifier or authenticate() would.
function who(roles: string[], email = "a@x.com"): Principal {
  return markAuthentic({
    kind: "custom",
    scheme: "bearer",
    subject: "u",
    email,
    roles,
  });
}

function record(): Rec {
  return {
    id: "1",
    email: "a@x.com",
    yearlyWage: 100,
    internalNotes: "note",
    debug: "d",
  };
}

const self = (r: Rec, p: Principal | undefined) =>
  r.email === p?.email?.toLowerCase();

describe("transform second argument", () => {
  /**
   * @case transform passes the current exchange as a second argument
   * @preconditions A route attaches a principal then transforms using it
   * @expectedResult The transformer can read ex.principal to shape the body
   */
  test("the transformer receives the exchange", async () => {
    const s = spy<{ subject?: string }>();
    const principalSource: Source<Record<string, never>> = {
      subscribe: async (sub) =>
        void (await sub.emit({
          message: {},
          headers: { [HeadersKeys.AUTH_PRINCIPAL]: who(["x"]) },
        })),
    };

    const route = await testContext()
      .routes(
        craft()
          .id("two-arg")
          .from(principalSource)
          .transform((body, ex) => ({
            ...body,
            subject: ex.principal?.subject,
          }))
          .to(s),
      )
      .build();
    await route.test();
    await route.stop();

    expect(s.receivedBodies()).toEqual([{ subject: "u" }]);
  });
});

describe("mask helper", () => {
  /**
   * @case mask obfuscates listed fields and ignores the principal
   * @preconditions A record with an email; mask rewrites email; no principal
   * @expectedResult email is replaced, other fields untouched
   */
  test("obfuscates listed fields, leaves others", () => {
    const out = mask<Rec>({ email: () => "***" })(record(), mk(record()));
    expect(out.email).toBe("***");
    expect(out.id).toBe("1");
    expect(out.yearlyWage).toBe(100);
  });

  /**
   * @case mask applies element-wise to an array body
   * @preconditions Body is an array of records
   * @expectedResult Each element's listed field is obfuscated
   */
  test("applies to each element of an array body", () => {
    const arr: Rec[] = [record(), { ...record(), email: "b@x.com" }];
    const out = mask<Rec>({ email: () => "***" })(arr, mk(arr));
    expect(out.map((r) => r.email)).toEqual(["***", "***"]);
  });

  /**
   * @case mask rewrites a nested dot-path value
   * @preconditions Record with card.number; mask targets "card.number"
   * @expectedResult Only the nested value changes, siblings preserved
   */
  test("masks a nested field by dot path", () => {
    const rec: Rec = { ...record(), card: { number: "card_token_ends_1234" } };
    const out = mask<Rec>({
      "card.number": (v) => "**** " + String(v).slice(-4),
    })(rec, mk(rec));
    expect(out.card).toEqual({ number: "**** 1234" });
    expect(out.id).toBe("1");
  });
});

describe("keep helper (strict by default)", () => {
  /**
   * @case strict mode keeps only listed fields, gated by a role grant
   * @preconditions Rules list id/email (always) and yearlyWage/internalNotes (hr); debug is unlisted
   * @expectedResult hr keeps all listed; member keeps only the always fields; unlisted debug dropped for both
   */
  test("strict keeps only listed fields and drops unlisted", () => {
    const rules = {
      id: true as const,
      email: true as const,
      yearlyWage: ["hr"],
      internalNotes: ["hr"],
    };

    const asHr = keep<Rec>(rules)(record(), mk(record(), who(["hr"])));
    expect(asHr).toEqual({
      id: "1",
      email: "a@x.com",
      yearlyWage: 100,
      internalNotes: "note",
    });
    expect("debug" in asHr).toBe(false);

    const asMember = keep<Rec>(rules)(record(), mk(record(), who(["member"])));
    expect(asMember).toEqual({ id: "1", email: "a@x.com" });
  });

  /**
   * @case a predicate grant (self) keeps a field only on the caller's own record
   * @preconditions yearlyWage gated by [self, "hr"]; caller is the record owner vs a stranger
   * @expectedResult owner keeps yearlyWage; stranger without hr loses it
   */
  test("predicate grant keeps own field, drops for others", () => {
    const rules = { email: true as const, yearlyWage: [self, "hr"] };

    const owner = keep<Rec>(rules)(
      record(),
      mk(record(), who(["member"], "a@x.com")),
    );
    expect(owner.yearlyWage).toBe(100);

    const stranger = keep<Rec>(rules)(
      record(),
      mk(record(), who(["member"], "b@y.com")),
    );
    expect("yearlyWage" in stranger).toBe(false);
  });

  /**
   * @case grants fail closed when there is no principal
   * @preconditions Field gated by a role; the exchange carries no principal
   * @expectedResult Always fields survive; role-gated fields are dropped
   */
  test("fails closed without a principal", () => {
    const out = keep<Rec>({ id: true, yearlyWage: ["hr"] })(
      record(),
      mk(record()),
    );
    expect(out).toEqual({ id: "1" });
  });

  /**
   * @case A self-asserted (non-authentic) principal does not unlock gated fields
   * @preconditions A raw, unbranded principal carrying roles ["hr"] is on the exchange
   * @expectedResult keep ignores it (treats it as missing), so the hr-gated field is dropped
   */
  test("ignores a self-asserted, non-authentic principal", () => {
    const rawHr: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "x",
      email: "a@x.com",
      roles: ["hr"],
    };
    const out = keep<Rec>({ id: true, yearlyWage: ["hr"] })(
      record(),
      mk(record(), rawHr),
    );
    expect(out).toEqual({ id: "1" });
  });

  /**
   * @case Non-record elements of an array body pass through unchanged
   * @preconditions An array body whose elements include a nested array
   * @expectedResult Record elements are shaped; the nested array is returned as-is, not {}
   */
  test("passes non-record array elements through unchanged", () => {
    const inner = ["a", "b"];
    const arr: unknown[] = [record(), inner];
    const run = keep<Rec>({ id: true }) as unknown as (
      body: unknown[],
      ex: Exchange<unknown>,
    ) => unknown[];
    const out = run(arr, mk(arr, who(["member"])) as Exchange<unknown>);
    expect(out[0]).toEqual({ id: "1" });
    expect(out[1]).toBe(inner);
  });

  /**
   * @case nested dot-path fields are gated like flat ones
   * @preconditions review.rating gated by hr; id always
   * @expectedResult hr keeps id + review.rating; member keeps id only
   */
  test("gates nested fields by dot path", () => {
    const rec: Rec = { ...record(), review: { rating: 5, note: "x" } };
    const rules = { id: true as const, "review.rating": ["hr"] };

    const asHr = keep<Rec>(rules)(rec, mk(rec, who(["hr"])));
    expect(asHr).toEqual({ id: "1", review: { rating: 5 } });

    const asMember = keep<Rec>(rules)(rec, mk(rec, who(["member"])));
    expect(asMember).toEqual({ id: "1" });
  });

  /**
   * @case keep applies element-wise to an array body
   * @preconditions Array of records; member caller; wage gated by hr
   * @expectedResult Each element is reduced to the allowed fields
   */
  test("applies to each element of an array body", () => {
    const arr: Rec[] = [record(), { ...record(), id: "2" }];
    const out = keep<Rec>({ id: true, yearlyWage: ["hr"] })(
      arr,
      mk(arr, who(["member"])),
    );
    expect(out).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

describe("keep helper (non-strict)", () => {
  /**
   * @case non-strict gates listed fields and passes unlisted through
   * @preconditions strict:false; yearlyWage/internalNotes gated by hr; debug unlisted
   * @expectedResult member loses the gated fields but keeps id, email, and the unlisted debug
   */
  test("keeps unlisted fields, drops only failed gated fields", () => {
    const out = keep<Rec>(
      { yearlyWage: ["hr"], internalNotes: ["hr"] },
      { strict: false },
    )(record(), mk(record(), who(["member"])));
    expect(out).toEqual({ id: "1", email: "a@x.com", debug: "d" });
  });
});

describe("compose keep then mask", () => {
  /**
   * @case keep removes unauthorized fields, then mask obfuscates what remains
   * @preconditions member caller; keep drops internalNotes (hr only); mask obscures email
   * @expectedResult internalNotes gone, email masked, id retained
   */
  test("keep then mask", () => {
    const ex = mk(record(), who(["member"]));
    const kept = keep<Rec>({ id: true, email: true, internalNotes: ["hr"] })(
      record(),
      ex,
    );
    const masked = mask<Rec>({ email: () => "***" })(kept, ex);
    expect(masked).toEqual({ id: "1", email: "***" });
  });
});

describe("keep rule-order independence", () => {
  interface Tiered {
    tier: string;
    secret: string;
    other: string;
  }
  const isGold = (r: Tiered) => r.tier === "gold";
  const rec = (): Tiered => ({ tier: "gold", secret: "s", other: "o" });

  /**
   * @case A predicate grant reading a field that another rule drops is order-independent
   * @preconditions Non-strict; `tier` gated by hr (member fails, so it is dropped),
   *                `secret` gated by a predicate that reads `tier`; member caller
   * @expectedResult Both rule orders keep `secret` (the predicate sees the original
   *                 `tier`) and drop `tier`; the two orderings produce equal output
   */
  test("non-strict grants evaluate against the original record", () => {
    const ex = mk(rec(), who(["member"]));
    const tierFirst = keep<Tiered>(
      { tier: ["hr"], secret: [isGold] },
      { strict: false },
    )(rec(), ex);
    const secretFirst = keep<Tiered>(
      { secret: [isGold], tier: ["hr"] },
      { strict: false },
    )(rec(), ex);

    expect(tierFirst).toEqual(secretFirst);
    expect("secret" in tierFirst).toBe(true);
    expect("tier" in tierFirst).toBe(false);
  });
});

describe("type-level contracts", () => {
  /**
   * @case A one-argument transformer is still assignable to CallableTransformer
   * @preconditions Assign a `(body) => body` function to the two-arg type
   * @expectedResult Compiles (backwards compatible) and runs when called with two args
   */
  test("transform second argument is backwards compatible", () => {
    const oneArg: CallableTransformer<string, string> = (b) => b.toUpperCase();
    expectTypeOf<(b: string) => string>().toMatchTypeOf<
      CallableTransformer<string, string>
    >();
    expect(oneArg("a", mk("a"))).toBe("A");
  });

  /**
   * @case keep and mask preserve the precise body type for record and array bodies
   * @preconditions Apply each helper to a single record and to an array, no casts
   * @expectedResult The single-record call is typed `Rec`, the array call `Rec[]`
   */
  test("keep and mask preserve the body type", () => {
    const single = keep<Rec>({ id: true })(record(), mk(record()));
    expectTypeOf(single).toEqualTypeOf<Rec>();

    const arr: Rec[] = [record()];
    const many = keep<Rec>({ id: true })(arr, mk(arr));
    expectTypeOf(many).toEqualTypeOf<Rec[]>();

    const masked = mask<Rec>({ email: () => "x" })(record(), mk(record()));
    expectTypeOf(masked).toEqualTypeOf<Rec>();

    expect(single.id).toBe("1");
  });
});
