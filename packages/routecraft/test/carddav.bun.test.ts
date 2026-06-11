import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  carddav,
  VCard,
  VCARD,
  VPARAM,
  CarddavHeaders,
  type VCardBody,
} from "@routecraft/routecraft";
import { CarddavAdapter } from "../src/adapters/carddav/index.ts";
import { CarddavClientManager } from "../src/adapters/carddav/client-manager.ts";
import { EXCHANGE_INTERNALS } from "../src/exchange.ts";
import type {
  CarddavDriverClient,
  DAVAddressBookLike,
  DAVVCardLike,
} from "../src/adapters/carddav/shared.ts";
import type {
  CarddavDeleteResult,
  CarddavWriteResult,
} from "../src/adapters/carddav/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOK_URL = "https://dav/card/";

/**
 * A realistic iCloud-shaped vCard 3.0 export: multi-valued TYPE params with a
 * PREF flag, a grouped ADR with an extended-address component, a custom
 * X-ABLabel on a phone, a labeled related name, a social profile, and two
 * unmodeled properties (PRODID, X-CUSTOM-FIELD).
 */
const ICLOUD_VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iOS 17//EN",
  "N:Doe;Jane;Q;;",
  "FN:Jane Q Doe",
  "ORG:Acme Inc.;Engineering",
  "TITLE:Engineer",
  "EMAIL;type=INTERNET;type=HOME;type=pref:jane@example.com",
  "TEL;type=CELL;type=VOICE;type=pref:+15551234567",
  "item1.TEL:+15559990000",
  "item1.X-ABLabel:School",
  "ADR;type=HOME;type=pref:;Apt 4B;123 Main St;Springfield;IL;62704;USA",
  "X-SOCIALPROFILE;type=twitter:https://twitter.com/jane",
  "item2.X-ABRELATEDNAMES;type=pref:Jordan",
  "item2.X-ABLabel:_$!<Spouse>!$_",
  "BDAY:1990-05-21",
  "NOTE:Met at the conference.",
  "URL:https://jane.example.com",
  "X-CUSTOM-FIELD:keepme",
  "UID:ABC-123",
  "END:VCARD",
].join("\r\n");

const ACCOUNT_CONFIG = {
  carddav: {
    accounts: {
      default: { username: "jane@example.com", appPassword: "app-pw" },
    },
  },
};

// ---------------------------------------------------------------------------
// In-memory CardDAV fake (behaves like a precondition-honoring server)
// ---------------------------------------------------------------------------

interface FakeDriver extends CarddavDriverClient {
  created: Array<{ vCardString: string; filename: string }>;
  updated: Array<{ vCard: DAVVCardLike }>;
  deleted: Array<{ vCard: DAVVCardLike }>;
  calls: { fetchVCards: number; fetchBooks: number };
}

function fakeDriver(initial: DAVVCardLike[] = []): FakeDriver {
  const book: DAVAddressBookLike = { url: BOOK_URL, displayName: "Card" };
  const cards = new Map<string, DAVVCardLike>(
    initial.map((c) => [c.url, { ...c }]),
  );
  const created: FakeDriver["created"] = [];
  const updated: FakeDriver["updated"] = [];
  const deleted: FakeDriver["deleted"] = [];
  const calls = { fetchVCards: 0, fetchBooks: 0 };

  return {
    created,
    updated,
    deleted,
    calls,
    fetchAddressBooks: async () => {
      calls.fetchBooks++;
      return [book];
    },
    fetchVCards: async () => {
      calls.fetchVCards++;
      return [...cards.values()];
    },
    createVCard: async (p) => {
      created.push({ vCardString: p.vCardString, filename: p.filename });
      const url = `${p.addressBook.url}${p.filename}`;
      if (cards.has(url)) return new Response(null, { status: 412 });
      cards.set(url, { url, etag: '"new-etag"', data: p.vCardString });
      return new Response(null, {
        status: 201,
        headers: { etag: '"new-etag"' },
      });
    },
    updateVCard: async (p) => {
      updated.push({ vCard: p.vCard });
      const existing = cards.get(p.vCard.url);
      if (!existing) return new Response(null, { status: 404 });
      if (p.vCard.etag && existing.etag && p.vCard.etag !== existing.etag) {
        return new Response(null, { status: 412 });
      }
      // Conditional spread: DAVVCardLike.data is optional and
      // exactOptionalPropertyTypes forbids assigning an explicit undefined.
      const data = p.vCard.data ?? existing.data;
      cards.set(p.vCard.url, {
        url: p.vCard.url,
        etag: '"upd-etag"',
        ...(data !== undefined ? { data } : {}),
      });
      return new Response(null, {
        status: 200,
        headers: { etag: '"upd-etag"' },
      });
    },
    deleteVCard: async (p) => {
      deleted.push({ vCard: p.vCard });
      if (!cards.has(p.vCard.url)) return new Response(null, { status: 404 });
      cards.delete(p.vCard.url);
      return new Response(null, { status: 204 });
    },
  };
}

const ORIGINAL_CREATE_DRIVER = CarddavClientManager.createDriverClient;
afterEach(() => {
  CarddavClientManager.createDriverClient = ORIGINAL_CREATE_DRIVER;
});

/** A minimal context carrying the carddav store, for direct `adapter.send`. */
async function carddavCtx(): Promise<TestContext> {
  return testContext()
    .with(ACCOUNT_CONFIG)
    .routes(craft().id("noop").from(simple("noop")).to(spy()))
    .build();
}

/** Build an exchange with explicit headers/body and attach a context. */
function exchangeWith(
  headers: Record<string, unknown>,
  body: unknown,
  t: TestContext,
): never {
  const exchange = { id: "x", headers, body, logger: console } as never;
  EXCHANGE_INTERNALS.set(exchange as never, { context: t.ctx } as never);
  return exchange;
}

// ---------------------------------------------------------------------------
// VCard document (plain body + wrapper)
// ---------------------------------------------------------------------------

describe("VCard document", () => {
  describe("reading", () => {
    /**
     * @case Parse a vCard and read it through the wrapper
     * @preconditions A full iCloud vCard 3.0
     * @expectedResult Properties, params, components, version, and uid are readable
     */
    test("exposes properties, params, components, version, and uid", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.version).toBe("3.0");
      expect(card.uid).toBe("ABC-123");
      expect(card.text("FN")).toBe("Jane Q Doe");
      expect(card.get("TEL")).toHaveLength(2);
      expect(card.first("EMAIL")?.param(VPARAM.TYPE)).toBe("INTERNET");
      expect(card.first("N")?.components()).toEqual([
        "Doe",
        "Jane",
        "Q",
        "",
        "",
      ]);
      expect(card.text("NOTE")).toBe("Met at the conference.");
    });

    /**
     * @case The body is plain data (no methods, JSON-safe)
     * @preconditions A parsed card's `.data`
     * @expectedResult `.data` is a plain object whose properties carry values
     */
    test("the body is plain serializable data", () => {
      const body: VCardBody = VCard.parse(ICLOUD_VCARD).data;
      expect(typeof (body as { text?: unknown }).text).toBe("undefined");
      const json = JSON.parse(JSON.stringify(body));
      expect(json.version).toBe("3.0");
      const fn = json.properties.find((p: { name: string }) => p.name === "FN");
      expect(fn.value).toBe("Jane Q Doe");
    });

    /**
     * @case Unmodeled and grouped properties survive as ordinary properties
     * @preconditions A card with PRODID, X-CUSTOM-FIELD, and a grouped X-ABLabel
     * @expectedResult They appear in the property list like any other property
     */
    test("keeps unmodeled and grouped properties", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.text("PRODID")).toBe("-//Apple Inc.//iOS 17//EN");
      expect(card.text("X-CUSTOM-FIELD")).toBe("keepme");
      const labeled = card.get("TEL").find((p) => p.group === "item1");
      expect(labeled?.value).toBe("+15559990000");
      const label = card.get("X-ABLabel").find((p) => p.group === "item1");
      expect(label?.value).toBe("School");
    });
  });

  describe("round-trip losslessness", () => {
    /**
     * @case Read then write then read drops nothing
     * @preconditions A rich iCloud card
     * @expectedResult Serialization is idempotent and every property survives
     */
    test("parse -> toString is idempotent and complete", () => {
      const out1 = VCard.parse(ICLOUD_VCARD).toString();
      const out2 = VCard.parse(out1).toString();
      expect(out2).toBe(out1);
      expect(out1).toContain("PRODID:-//Apple Inc.//iOS 17//EN");
      expect(out1).toContain("X-CUSTOM-FIELD:keepme");
      expect(out1).toContain("item1.X-ABLabel:School");
      expect(out1).toContain("item2.X-ABLabel:_$!<Spouse>!$_");
      expect(out1).toContain(";Apt 4B;123 Main St;");
      expect(out1).toContain("type=CELL;type=VOICE;type=pref");
    });
  });

  describe("writing", () => {
    /**
     * @case wrap edits the underlying body in place
     * @preconditions A plain body wrapped and mutated
     * @expectedResult The body reflects the edits
     */
    test("wrap mutates the underlying body in place", () => {
      const body = VCard.parse(ICLOUD_VCARD).data;
      VCard.wrap(body).set("NOTE", "new note").remove("X-CUSTOM-FIELD");
      const reread = VCard.wrap(body);
      expect(reread.text("NOTE")).toBe("new note");
      expect(reread.first("X-CUSTOM-FIELD")).toBeUndefined();
    });

    /**
     * @case create builds a fresh body, add appends, and `.data` is the body
     * @preconditions VCard.create().add(...)
     * @expectedResult The serialized card re-parses to the added fields
     */
    test("create / add build a body", () => {
      const body = VCard.create()
        .add("FN", "Sam Lee")
        .add("EMAIL", "sam@lee.com", {
          params: [{ name: "type", value: "work" }],
        }).data;
      const round = VCard.wrap(body);
      expect(round.text("FN")).toBe("Sam Lee");
      expect(round.first("EMAIL")?.param("type")).toBe("work");
      expect(VCard.serialize(body)).toContain("FN:Sam Lee");
    });

    /**
     * @case Special characters in a value round-trip without breaking the grammar
     * @preconditions A note with a comma, semicolon, and newline
     * @expectedResult The decoded value comes back identical
     */
    test("escapes and round-trips special characters", () => {
      const note = "a, b; c\nd";
      const out = VCard.create().add("FN", "X").add("NOTE", note).toString();
      expect(VCard.parse(out).text("NOTE")).toBe(note);
    });

    /**
     * @case setComponents escapes each structured component
     * @preconditions An ORG component containing a comma
     * @expectedResult The component round-trips intact
     */
    test("setComponents escapes each component", () => {
      const card = VCard.create().add("FN", "X").add("ORG", "");
      card.first("ORG")!.setComponents(["Acme, Inc.", "R&D"]);
      const round = VCard.parse(card.toString());
      expect(round.first("ORG")?.components()).toEqual(["Acme, Inc.", "R&D"]);
    });

    /**
     * @case Long multibyte values fold to <=75 octets without splitting a glyph
     * @preconditions A note long enough to fold, with multibyte characters
     * @expectedResult Every physical line is <=75 octets and the value round-trips
     */
    test("folds long multibyte lines safely", () => {
      const note = "café ".repeat(40);
      const out = VCard.create().add("FN", "X").add("NOTE", note).toString();
      for (const line of out.split("\r\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      }
      expect(VCard.parse(out).text("NOTE")).toBe(note);
    });
  });

  describe("validation", () => {
    /**
     * @case Non-vCard input is rejected
     * @preconditions A string with no BEGIN/END:VCARD
     * @expectedResult VCard.parse throws a SyntaxError
     */
    test("rejects input without a VCARD envelope", () => {
      expect(() => VCard.parse("not a vcard")).toThrow(SyntaxError);
    });

    /**
     * @case A vCard collection is rejected
     * @preconditions Two BEGIN:VCARD blocks in one payload
     * @expectedResult VCard.parse throws a SyntaxError
     */
    test("rejects a multi-card collection", () => {
      expect(() => VCard.parse(`${ICLOUD_VCARD}\r\n${ICLOUD_VCARD}`)).toThrow(
        SyntaxError,
      );
    });

    /**
     * @case A grouped property named begin/end is not mistaken for the envelope
     * @preconditions A valid single card containing `item1.BEGIN:VCARD`
     * @expectedResult The card parses and keeps the grouped property as content
     */
    test("does not treat a grouped begin/end as the envelope", () => {
      const card = VCard.parse(
        [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "item1.BEGIN:VCARD",
          "FN:x",
          "END:VCARD",
        ].join("\r\n"),
      );
      expect(card.text("FN")).toBe("x");
    });

    /**
     * @case A property name/group that could break the header grammar is rejected
     * @preconditions add() with a name containing CRLF, a group with a dot, or an empty name
     * @expectedResult add() throws a SyntaxError
     */
    test("rejects an injectable property name or group", () => {
      expect(() => VCard.create().add("FN:x\r\nEVIL", "y")).toThrow(
        SyntaxError,
      );
      expect(() => VCard.create().add("OK", "y", { group: "a.b" })).toThrow(
        SyntaxError,
      );
      expect(() => VCard.create().add("", "y")).toThrow(SyntaxError);
    });
  });

  describe("constants", () => {
    /**
     * @case The name constants drive lookups and carry the wire names
     * @preconditions A parsed card read via VCARD / VPARAM constants
     * @expectedResult Reading by constant matches reading by string literal
     */
    test("VCARD / VPARAM resolve lookups", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.text(VCARD.FN)).toBe("Jane Q Doe");
      expect(card.first(VCARD.EMAIL)?.param(VPARAM.TYPE)).toBe("INTERNET");
      expect(VCARD.X_ABLABEL).toBe("X-ABLabel");
    });
  });
});

// ---------------------------------------------------------------------------
// Adapter: source (read)
// ---------------------------------------------------------------------------

describe("CardDAV source (read)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case The source emits one plain VCardBody per card, with identity on headers
   * @preconditions A driver returning two cards
   * @expectedResult Two exchanges; each body is plain; headers carry url/uid/etag
   */
  test("emits one plain body per card with identity on headers", async () => {
    CarddavClientManager.createDriverClient = async () =>
      fakeDriver([
        { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
        {
          url: `${BOOK_URL}def-456.vcf`,
          etag: '"2"',
          data: ICLOUD_VCARD.replace("ABC-123", "DEF-456"),
        },
      ]);

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(craft().from(carddav()).to(s))
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(2);
    const body = s.received[0]?.body as VCardBody;
    expect(typeof (body as { text?: unknown }).text).toBe("undefined");
    expect(VCard.wrap(body).text("FN")).toBe("Jane Q Doe");
    const headers = s.received[0]?.headers ?? {};
    expect(headers[CarddavHeaders.URL]).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(headers[CarddavHeaders.ETAG]).toBe('"1"');
    expect(headers[CarddavHeaders.UID]).toBe("ABC-123");
  });

  /**
   * @case The limit option caps how many cards are emitted
   * @preconditions Two cards available, limit 1
   * @expectedResult Only the first card is emitted
   */
  test("honors the limit option", async () => {
    CarddavClientManager.createDriverClient = async () =>
      fakeDriver([
        { url: `${BOOK_URL}a.vcf`, data: ICLOUD_VCARD },
        { url: `${BOOK_URL}b.vcf`, data: ICLOUD_VCARD },
      ]);

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(carddav({ limit: 1 }))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.received).toHaveLength(1);
  });

  /**
   * @case A malformed card is routed as a per-exchange parse failure
   * @preconditions One card whose body is not a valid vCard
   * @expectedResult The route records an error rather than tearing down the read
   */
  test("routes a malformed card to the error path", async () => {
    CarddavClientManager.createDriverClient = async () =>
      fakeDriver([{ url: `${BOOK_URL}bad.vcf`, data: "garbage" }]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(craft().from(carddav()).to(spy()))
      .build();
    await t.test();

    expect(t.errors.length).toBeGreaterThan(0);
  });

  /**
   * @case Enriching pulls all cards onto the triggering exchange
   * @preconditions A trigger source and a driver returning one card
   * @expectedResult The enriched body carries the fetched card data
   */
  test("enrich returns all cards", async () => {
    CarddavClientManager.createDriverClient = async () =>
      fakeDriver([
        { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
      ]);

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(craft().from(simple("trigger")).enrich(carddav()).to(s))
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    const body = s.received[0]?.body as Record<string, VCardBody>;
    expect(VCard.wrap(body["0"]!).text("FN")).toBe("Jane Q Doe");
  });
});

// ---------------------------------------------------------------------------
// Adapter: destination (write)
// ---------------------------------------------------------------------------

describe("CardDAV destination (write)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case save with no url creates a new card and injects a UID
   * @preconditions Empty book; a fresh body without url or UID
   * @expectedResult createVCard runs with a UID-bearing card; result.created is true
   */
  test("save creates when there is no url", async () => {
    const driver = fakeDriver([]);
    CarddavClientManager.createDriverClient = async () => driver;

    const body = VCard.create().add("FN", "Sam Lee").data;
    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(body))
          .to(carddav({ action: "save" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created).toHaveLength(1);
    expect(driver.created[0]?.vCardString).toContain("FN:Sam Lee");
    expect(driver.created[0]?.vCardString).toContain("UID:");
    expect((s.received[0]?.body as CarddavWriteResult).created).toBe(true);
    expect(driver.calls.fetchVCards).toBe(0);
  });

  /**
   * @case save without url updates an existing uid via the 412 conflict fallback
   * @preconditions A card exists at uid EXISTS; body has that uid, no url
   * @expectedResult create returns 412, the adapter locates the card and updates it
   */
  test("save without url updates an existing uid via conflict fallback", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}EXISTS.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;

    const body = VCard.create().add("UID", "EXISTS").add("FN", "Up Date").data;
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(body))
          .to(carddav({ action: "save" })),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created).toHaveLength(1);
    expect(driver.updated).toHaveLength(1);
    expect(driver.updated[0]?.vCard.url).toBe(`${BOOK_URL}EXISTS.vcf`);
  });

  /**
   * @case A UID with URL-unsafe characters is escaped into a single filename segment
   * @preconditions A fresh body whose UID contains a slash
   * @expectedResult The create filename is percent-encoded
   */
  test("url-escapes a UID with unsafe characters in the filename", async () => {
    const driver = fakeDriver([]);
    CarddavClientManager.createDriverClient = async () => driver;

    const body = VCard.create().add("UID", "foo/bar").add("FN", "Slash").data;
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(body))
          .to(carddav({ action: "create" })),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created[0]?.filename).toBe("foo%2Fbar.vcf");
  });

  /**
   * @case A non-VCard body is rejected
   * @preconditions The exchange body is a plain string
   * @expectedResult The route surfaces RC5001
   */
  test("rejects a non-VCard body", async () => {
    CarddavClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple("not a card"))
          // @ts-expect-error the destination is typed Destination<VCardBody>,
          // so a plain string body is rejected at the type level; this test
          // asserts the runtime RC5001 guard that protects plain-JS callers.
          .to(carddav({ action: "create" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5001")).toBe(true);
  });

  /**
   * @case A plain body survives tap's snapshot clone
   * @preconditions A plain VCardBody tapped into carddav({ action: 'save' })
   * @expectedResult The tapped write runs on the cloned plain body
   */
  test("a plain body survives tap's snapshot clone", async () => {
    const driver = fakeDriver([]);
    CarddavClientManager.createDriverClient = async () => driver;

    const body = VCard.create().add("FN", "Tapped").data;
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(body))
          .tap(carddav({ action: "save" }))
          .to(spy()),
      )
      .build();
    await t.test();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(driver.created).toHaveLength(1);
    expect(driver.created[0]?.vCardString).toContain("FN:Tapped");
  });

  // --- header-driven update paths (direct send) ---

  /**
   * @case update targets the url header with the etag header as If-Match
   * @preconditions Headers carry url + etag; the body is an edited VCardBody
   * @expectedResult updateVCard runs with url + etag and does not fetch
   */
  test("update targets url with If-Match and does not refetch", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;
    const ctx = await carddavCtx();

    const body = VCard.parse(ICLOUD_VCARD).set("NOTE", "updated").data;
    const adapter = new CarddavAdapter({ action: "update" });
    const result = (await adapter.send(
      exchangeWith(
        {
          [CarddavHeaders.URL]: `${BOOK_URL}abc-123.vcf`,
          [CarddavHeaders.ETAG]: '"1"',
        },
        body,
        ctx,
      ),
    )) as CarddavWriteResult;

    expect(driver.updated).toHaveLength(1);
    expect(driver.updated[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.updated[0]?.vCard.etag).toBe('"1"');
    expect(driver.updated[0]?.vCard.data).toContain("NOTE:updated");
    expect(driver.calls.fetchVCards).toBe(0);
    expect(driver.calls.fetchBooks).toBe(0);
    expect(result.created).toBe(false);
    await ctx.stop();
  });

  /**
   * @case A stale etag is rejected by the server precondition
   * @preconditions The server card is at etag "2"; the etag header is the stale "1"
   * @expectedResult The 412 surfaces as the non-retryable RC5030 conflict
   */
  test("update with a stale etag surfaces a conflict", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"2"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;
    const ctx = await carddavCtx();

    const adapter = new CarddavAdapter({ action: "update" });
    await expect(
      adapter.send(
        exchangeWith(
          {
            [CarddavHeaders.URL]: `${BOOK_URL}abc-123.vcf`,
            [CarddavHeaders.ETAG]: '"1"',
          },
          VCard.parse(ICLOUD_VCARD).data,
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ rc: "RC5030", retryable: false });
    await ctx.stop();
  });

  /**
   * @case update without a resolvable url is a hard error
   * @preconditions A body with no url header and no UID
   * @expectedResult The route surfaces RC5014
   */
  test("update without a url raises RC5014", async () => {
    CarddavClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(VCard.create().add("FN", "No Url").data))
          .to(carddav({ action: "update" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter: destination (delete)
// ---------------------------------------------------------------------------

describe("CardDAV destination (delete)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Delete by the url header targets the resource directly with its etag
   * @preconditions Headers carry url + etag
   * @expectedResult deleteVCard runs with url + etag; no fetch happens
   */
  test("deletes by url header without refetching", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;
    const ctx = await carddavCtx();

    const adapter = new CarddavAdapter({ action: "delete" });
    const result = (await adapter.send(
      exchangeWith(
        {
          [CarddavHeaders.URL]: `${BOOK_URL}abc-123.vcf`,
          [CarddavHeaders.ETAG]: '"1"',
        },
        VCard.create().data,
        ctx,
      ),
    )) as CarddavDeleteResult;

    expect(driver.deleted[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.deleted[0]?.vCard.etag).toBe('"1"');
    expect(driver.calls.fetchVCards).toBe(0);
    expect(result.deleted).toBe(true);
    await ctx.stop();
  });

  /**
   * @case Delete via a target extractor still sends the etag header as If-Match
   * @preconditions A target extractor supplies the url; the etag header is set
   * @expectedResult deleteVCard receives the etag
   */
  test("delete via target extractor still sends the etag", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;
    const ctx = await carddavCtx();

    const adapter = new CarddavAdapter({
      action: "delete",
      target: () => ({ url: `${BOOK_URL}abc-123.vcf` }),
    });
    await adapter.send(
      exchangeWith({ [CarddavHeaders.ETAG]: '"1"' }, VCard.create().data, ctx),
    );

    expect(driver.deleted[0]?.vCard.etag).toBe('"1"');
    await ctx.stop();
  });

  /**
   * @case Delete by uid (no url) looks the contact up first
   * @preconditions A card exists; the body carries only its UID
   * @expectedResult The adapter fetches, finds the match, and deletes it
   */
  test("deletes by uid via lookup", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}not-the-uid.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CarddavClientManager.createDriverClient = async () => driver;

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(VCard.create().add("UID", "ABC-123").data))
          .to(carddav({ action: "delete" })),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.calls.fetchVCards).toBe(1);
    expect(driver.deleted[0]?.vCard.url).toBe(`${BOOK_URL}not-the-uid.vcf`);
  });

  /**
   * @case Delete with no resolvable target is a hard error
   * @preconditions Empty book; the body carries an unknown UID
   * @expectedResult The route surfaces RC5014
   */
  test("delete without a match raises RC5014", async () => {
    CarddavClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(VCard.create().add("UID", "missing").data))
          .to(carddav({ action: "delete" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });
});
