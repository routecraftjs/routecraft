import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  carddav,
  VCard,
  VCARD,
  VPARAM,
} from "@routecraft/routecraft";
import { CardDAVClientManager } from "../src/adapters/carddav/client-manager.ts";
import type {
  CardDAVDriverClient,
  DAVAddressBookLike,
  DAVVCardLike,
} from "../src/adapters/carddav/shared.ts";
import type {
  CardDAVDeleteResult,
  CardDAVWriteResult,
} from "../src/adapters/carddav/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOK_URL = "https://dav/card/";

/**
 * A realistic iCloud-shaped vCard 3.0 export: multi-valued TYPE params with a
 * PREF flag, a grouped ADR with an extended-address component, a custom
 * X-ABLabel on a phone, a labeled related name and date, a social profile, and
 * two unmodeled properties (PRODID, X-CUSTOM-FIELD).
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

interface FakeDriver extends CardDAVDriverClient {
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
      cards.set(p.vCard.url, {
        url: p.vCard.url,
        etag: '"upd-etag"',
        data: p.vCard.data ?? existing.data,
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

const ORIGINAL_CREATE_DRIVER = CardDAVClientManager.createDriverClient;
afterEach(() => {
  CardDAVClientManager.createDriverClient = ORIGINAL_CREATE_DRIVER;
});

// ---------------------------------------------------------------------------
// VCard document model
// ---------------------------------------------------------------------------

describe("VCard document", () => {
  describe("reading", () => {
    /**
     * @case Parse a vCard into a property document
     * @preconditions A full iCloud vCard 3.0
     * @expectedResult Properties, params, components, version, and uid are readable
     */
    test("exposes properties, params, components, version, and uid", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.version).toBe("3.0");
      expect(card.uid).toBe("ABC-123");
      expect(card.text("FN")).toBe("Jane Q Doe");
      expect(card.get("TEL")).toHaveLength(2);
      expect(card.first("EMAIL")?.param("type")).toBe("INTERNET");
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
     * @case Unmodeled and grouped properties are present as ordinary properties
     * @preconditions A card with PRODID, X-CUSTOM-FIELD, and a grouped X-ABLabel
     * @expectedResult They appear in the property list like any other property
     */
    test("keeps unmodeled and grouped properties", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.text("PRODID")).toBe("-//Apple Inc.//iOS 17//EN");
      expect(card.text("X-CUSTOM-FIELD")).toBe("keepme");
      const labeledTel = card.get("TEL").find((p) => p.group === "item1");
      expect(labeledTel?.value).toBe("+15559990000");
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
      // Nothing dropped, including the things a typed model would have lost.
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
     * @case set replaces a property, remove deletes it, add appends
     * @preconditions A parsed card
     * @expectedResult The property list reflects each mutation
     */
    test("set / add / remove mutate the property list", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      card.set("NOTE", "new note");
      expect(card.text("NOTE")).toBe("new note");
      expect(card.get("NOTE")).toHaveLength(1);

      card.add("TEL", "+15550000000", {
        params: [{ name: "type", value: "work" }],
      });
      expect(card.get("TEL")).toHaveLength(3);

      card.remove("X-CUSTOM-FIELD");
      expect(card.first("X-CUSTOM-FIELD")).toBeUndefined();
      expect(card.toString()).not.toContain("X-CUSTOM-FIELD");
    });

    /**
     * @case Special characters in a value round-trip without breaking the grammar
     * @preconditions A note with a comma, semicolon, and newline
     * @expectedResult The decoded value comes back identical
     */
    test("escapes and round-trips special characters", () => {
      const note = "a, b; c\nd";
      const card = new VCard().add("FN", "X").add("NOTE", note);
      expect(VCard.parse(card.toString()).text("NOTE")).toBe(note);
    });

    /**
     * @case Structured components escape per-component separators
     * @preconditions An ORG component containing a comma, set via setComponents
     * @expectedResult The component round-trips intact
     */
    test("setComponents escapes each component", () => {
      const card = new VCard().add("FN", "X");
      card.add("ORG", "").first("ORG")!.setComponents(["Acme, Inc.", "R&D"]);
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
      const out = new VCard().add("FN", "X").add("NOTE", note).toString();
      for (const line of out.split("\r\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      }
      expect(VCard.parse(out).text("NOTE")).toBe(note);
    });

    /**
     * @case clone produces an independent copy
     * @preconditions A parsed card cloned and mutated
     * @expectedResult The original is unchanged
     */
    test("clone is independent", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      const copy = card.clone();
      copy.set("NOTE", "changed");
      expect(card.text("NOTE")).toBe("Met at the conference.");
      expect(copy.text("NOTE")).toBe("changed");
    });
  });

  describe("constants", () => {
    /**
     * @case The name constants resolve property and parameter lookups
     * @preconditions A parsed card read via VCARD / VPARAM constants
     * @expectedResult Reading by constant matches reading by string literal
     */
    test("VCARD / VPARAM drive lookups and carry the wire names", () => {
      const card = VCard.parse(ICLOUD_VCARD);
      expect(card.text(VCARD.FN)).toBe("Jane Q Doe");
      expect(card.first(VCARD.EMAIL)?.param(VPARAM.TYPE)).toBe("INTERNET");
      expect(VCARD.X_ABLABEL).toBe("X-ABLabel");
      expect(VCARD.X_SOCIALPROFILE).toBe("X-SOCIALPROFILE");
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
     * @case A vCard collection is rejected rather than flattened
     * @preconditions Two BEGIN:VCARD blocks in one payload
     * @expectedResult VCard.parse throws a SyntaxError
     */
    test("rejects a multi-card collection", () => {
      expect(() => VCard.parse(`${ICLOUD_VCARD}\r\n${ICLOUD_VCARD}`)).toThrow(
        SyntaxError,
      );
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
   * @case The source emits one VCard per card, carrying url and etag
   * @preconditions A driver returning two cards
   * @expectedResult Two exchanges, each body a VCard with its url/etag
   */
  test("emits one VCard per card", async () => {
    CardDAVClientManager.createDriverClient = async () =>
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
    const first = s.received[0]?.body as VCard;
    expect(first).toBeInstanceOf(VCard);
    expect(first.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(first.etag).toBe('"1"');
    expect(first.uid).toBe("ABC-123");
  });

  /**
   * @case The limit option caps how many cards are emitted
   * @preconditions Two cards available, limit 1
   * @expectedResult Only the first card is emitted
   */
  test("honors the limit option", async () => {
    CardDAVClientManager.createDriverClient = async () =>
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
    CardDAVClientManager.createDriverClient = async () =>
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
   * @expectedResult The enriched body carries the fetched VCard
   */
  test("enrich returns all cards", async () => {
    CardDAVClientManager.createDriverClient = async () =>
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
    const body = s.received[0]?.body as Record<string, VCard>;
    expect(body["0"]?.text("FN")).toBe("Jane Q Doe");
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
   * @case save with no existing url creates a new card and injects a UID
   * @preconditions Empty address book; a new VCard without url or UID
   * @expectedResult createVCard is called with a UID-bearing card; result.created is true
   */
  test("save creates when there is no url", async () => {
    const driver = fakeDriver([]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = new VCard().add("FN", "Sam Lee");
    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(carddav({ action: "save" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created).toHaveLength(1);
    expect(driver.created[0]?.vCardString).toContain("FN:Sam Lee");
    expect(driver.created[0]?.vCardString).toContain("UID:");
    const result = s.received[0]?.body as CardDAVWriteResult;
    expect(result.created).toBe(true);
    expect(driver.calls.fetchVCards).toBe(0);
  });

  /**
   * @case update writes to the card's url with its read-time etag as If-Match
   * @preconditions A card exists; the body is a VCard carrying that url and etag
   * @expectedResult updateVCard is called with url + etag; no address-book fetch happens
   */
  test("update targets url with If-Match and does not refetch", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = VCard.parse(ICLOUD_VCARD);
    card.url = `${BOOK_URL}abc-123.vcf`;
    card.etag = '"1"';
    card.set("NOTE", "updated");

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(carddav({ action: "update" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.updated).toHaveLength(1);
    expect(driver.updated[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.updated[0]?.vCard.etag).toBe('"1"');
    expect(driver.updated[0]?.vCard.data).toContain("NOTE:updated");
    expect(driver.calls.fetchVCards).toBe(0);
    expect(driver.calls.fetchBooks).toBe(0);
    const result = s.received[0]?.body as CardDAVWriteResult;
    expect(result.created).toBe(false);
  });

  /**
   * @case A stale etag is rejected by the server precondition (lost-update guard)
   * @preconditions The server card is at etag "2"; the body carries the stale "1"
   * @expectedResult The 412 surfaces as the non-retryable RC5028 conflict code
   */
  test("update with a stale etag surfaces a conflict", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"2"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = VCard.parse(ICLOUD_VCARD);
    card.url = `${BOOK_URL}abc-123.vcf`;
    card.etag = '"1"';

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(carddav({ action: "update" })),
      )
      .build();
    await t.test();

    const conflict = t.errors.find((e) => e.rc === "RC5028");
    expect(conflict).toBeDefined();
    expect(conflict?.retryable).toBe(false);
  });

  /**
   * @case update without a resolvable url is a hard error
   * @preconditions A VCard with neither url nor headers
   * @expectedResult The route surfaces RC5014
   */
  test("update without a url raises RC5014", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(new VCard().add("FN", "No Url")))
          .to(carddav({ action: "update" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });

  /**
   * @case save without url falls back to update when the resource already exists
   * @preconditions A card already exists at uid EXISTS.vcf; body has that uid, no url
   * @expectedResult create returns 412, the adapter locates the card and updates it
   */
  test("save without url updates an existing uid via conflict fallback", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}EXISTS.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = new VCard().add("UID", "EXISTS").add("FN", "Up Date");
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(carddav({ action: "save" })),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created).toHaveLength(1); // attempted, hit 412
    expect(driver.updated).toHaveLength(1); // then updated
    expect(driver.updated[0]?.vCard.url).toBe(`${BOOK_URL}EXISTS.vcf`);
  });

  /**
   * @case A non-VCard body is rejected
   * @preconditions The exchange body is a plain string
   * @expectedResult The route surfaces RC5001
   */
  test("rejects a non-VCard body", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple("not a card" as unknown as VCard))
          .to(carddav({ action: "create" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5001")).toBe(true);
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
   * @case Delete by url targets the resource directly with its etag
   * @preconditions A card exists; the body is a VCard carrying its url and etag
   * @expectedResult deleteVCard is called with url + etag; no fetch happens
   */
  test("deletes by url without refetching", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = VCard.parse(ICLOUD_VCARD);
    card.url = `${BOOK_URL}abc-123.vcf`;
    card.etag = '"1"';

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(carddav({ action: "delete" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.deleted[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.deleted[0]?.vCard.etag).toBe('"1"');
    expect(driver.calls.fetchVCards).toBe(0);
    const result = s.received[0]?.body as CardDAVDeleteResult;
    expect(result.deleted).toBe(true);
  });

  /**
   * @case Delete via a custom target extractor still sends If-Match
   * @preconditions A card exists; a target extractor supplies its url; the VCard carries the etag
   * @expectedResult deleteVCard receives the read-time etag
   */
  test("delete via target extractor still sends the etag", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const card = VCard.parse(ICLOUD_VCARD);
    card.etag = '"1"';

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(card))
          .to(
            carddav({
              action: "delete",
              target: () => ({ url: `${BOOK_URL}abc-123.vcf` }),
            }),
          ),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.deleted[0]?.vCard.etag).toBe('"1"');
  });

  /**
   * @case Delete by uid (no url) looks the contact up first
   * @preconditions A card exists; the VCard carries only its uid (no url)
   * @expectedResult The adapter fetches, finds the match, and deletes it
   */
  test("deletes by uid via lookup", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}not-the-uid.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(new VCard().add("UID", "ABC-123")))
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
   * @preconditions Empty address book; the VCard carries an unknown uid
   * @expectedResult The route surfaces RC5014
   */
  test("delete without a match raises RC5014", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(new VCard().add("UID", "missing")))
          .to(carddav({ action: "delete" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });
});
