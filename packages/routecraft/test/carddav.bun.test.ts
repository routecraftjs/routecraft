import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, carddav } from "@routecraft/routecraft";
import { CardDAVClientManager } from "../src/adapters/carddav/client-manager.ts";
import {
  parseVCard,
  serializeContact,
} from "../src/adapters/carddav/vcard-codec.ts";
import { parseRecords } from "../src/adapters/carddav/vcard-raw.ts";
import type {
  CardDAVDriverClient,
  DAVAddressBookLike,
  DAVVCardLike,
} from "../src/adapters/carddav/shared.ts";
import type {
  CardDAVDeleteResult,
  CardDAVWriteResult,
  Contact,
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
  "item3.X-ABDATE;type=pref:2010-06-01",
  "item3.X-ABLabel:_$!<Anniversary>!$_",
  "BDAY:1990-05-21",
  "NOTE:Met at the conference.",
  "URL:https://jane.example.com",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ==",
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

/** Parse, serialize, and parse again; strip `raw` so the two are comparable. */
function roundTrip(vcard: string): { first: Contact; second: Contact } {
  const first = parseVCard(vcard);
  const second = parseVCard(serializeContact(first));
  delete first.raw;
  delete second.raw;
  return { first, second };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CardDAV vCard codec", () => {
  describe("reading", () => {
    /**
     * @case Parse a full iCloud vCard 3.0 into a normalized Contact
     * @preconditions A vCard with name, org, email, tel, adr, bday, note, url, photo, uid
     * @expectedResult Modeled fields map across and the original text is on `raw`
     */
    test("parses all modeled fields from an iCloud vCard", () => {
      const contact = parseVCard(ICLOUD_VCARD);
      expect(contact.uid).toBe("ABC-123");
      expect(contact.fullName).toBe("Jane Q Doe");
      expect(contact.lastName).toBe("Doe");
      expect(contact.firstName).toBe("Jane");
      expect(contact.middleName).toBe("Q");
      expect(contact.organization).toBe("Acme Inc.");
      expect(contact.department).toBe("Engineering");
      expect(contact.title).toBe("Engineer");
      expect(contact.emails?.[0]?.value).toBe("jane@example.com");
      expect(contact.emails?.[0]?.type).toBe("internet");
      expect(contact.phones?.[0]?.value).toBe("+15551234567");
      expect(contact.addresses?.[0]?.street).toBe("123 Main St");
      expect(contact.addresses?.[0]?.extended).toBe("Apt 4B");
      expect(contact.birthday).toBe("1990-05-21");
      expect(contact.note).toBe("Met at the conference.");
      expect(contact.urls?.[0]).toBe("https://jane.example.com");
      expect(contact.photo?.mediaType).toBe("JPEG");
      expect(contact.raw).toBe(ICLOUD_VCARD);
    });

    /**
     * @case Unmodeled properties are surfaced rather than silently dropped
     * @preconditions A card carrying PRODID and an X- field the model does not name
     * @expectedResult Both appear in `custom` with their verbatim values
     */
    test("captures unmodeled properties into custom", () => {
      const contact = parseVCard(ICLOUD_VCARD);
      const keys = (contact.custom ?? []).map((c) => c.key);
      expect(keys).toContain("PRODID");
      expect(keys).toContain("X-CUSTOM-FIELD");
      const custom = contact.custom?.find((c) => c.key === "X-CUSTOM-FIELD");
      expect(custom?.value).toBe("keepme");
    });

    /**
     * @case A custom Apple X-ABLabel on a phone is read as the item's label
     * @preconditions A grouped `item1.TEL` paired with `item1.X-ABLabel:School`
     * @expectedResult The second phone carries label "School" and the label is not duplicated into custom
     */
    test("reads a grouped X-ABLabel as the item label", () => {
      const contact = parseVCard(ICLOUD_VCARD);
      const labeled = contact.phones?.find((p) => p.value === "+15559990000");
      expect(labeled?.label).toBe("School");
      const customKeys = (contact.custom ?? []).map((c) => c.key.toLowerCase());
      expect(customKeys).not.toContain("x-ablabel");
    });

    /**
     * @case Apple's `_$!<Label>!$_` wrapper is decoded for related names and dates
     * @preconditions A spouse related name and an anniversary date
     * @expectedResult Labels read as "Spouse" and "Anniversary"
     */
    test("decodes Apple label wrappers", () => {
      const contact = parseVCard(ICLOUD_VCARD);
      expect(contact.relatedNames?.[0]).toMatchObject({
        label: "Spouse",
        name: "Jordan",
      });
      expect(contact.dates?.[0]).toMatchObject({
        label: "Anniversary",
        date: "2010-06-01",
      });
    });
  });

  describe("round-trip losslessness", () => {
    /**
     * @case Read then write then read drops nothing
     * @preconditions A rich iCloud card with params, labels, social, related, dates, custom
     * @expectedResult The re-parsed contact equals the original parse (minus `raw`)
     */
    test("parse -> serialize -> parse is lossless", () => {
      const { first, second } = roundTrip(ICLOUD_VCARD);
      expect(second).toEqual(first);
    });

    /**
     * @case Multi-valued TYPE params and the PREF flag survive a round-trip
     * @preconditions An email with `type=INTERNET;type=HOME;type=pref`
     * @expectedResult All three params are preserved verbatim, including casing
     */
    test("preserves multi-valued TYPE params and PREF", () => {
      const { second } = roundTrip(ICLOUD_VCARD);
      const email = second.emails?.[0];
      expect(email?.params).toEqual([
        { name: "type", value: "INTERNET" },
        { name: "type", value: "HOME" },
        { name: "type", value: "pref" },
      ]);
    });

    /**
     * @case The ADR extended-address component survives a round-trip
     * @preconditions An ADR whose component 2 is "Apt 4B"
     * @expectedResult The serialized card still carries the extended component
     */
    test("preserves the ADR extended component", () => {
      const { second } = roundTrip(ICLOUD_VCARD);
      expect(second.addresses?.[0]?.extended).toBe("Apt 4B");
    });

    /**
     * @case Built-in Apple labels are re-wrapped on write
     * @preconditions A spouse related name read from a `_$!<Spouse>!$_` wrapper
     * @expectedResult The serialized output contains the wrapped form again
     */
    test("re-wraps built-in Apple labels on write", () => {
      const out = serializeContact(parseVCard(ICLOUD_VCARD));
      expect(out).toContain("X-ABLabel:_$!<Spouse>!$_");
      // A custom label stays bare.
      expect(out).toContain("X-ABLabel:School");
    });

    /**
     * @case Unmodeled properties round-trip via custom
     * @preconditions A card with PRODID and X-CUSTOM-FIELD
     * @expectedResult Both are present in the serialized output
     */
    test("preserves unmodeled properties through custom", () => {
      const out = serializeContact(parseVCard(ICLOUD_VCARD));
      expect(out).toContain("PRODID:-//Apple Inc.//iOS 17//EN");
      expect(out).toContain("X-CUSTOM-FIELD:keepme");
    });
  });

  describe("writing & full replace", () => {
    /**
     * @case Serialize derives the mandatory FN when none is supplied
     * @preconditions A contact with name parts and an email but no fullName
     * @expectedResult A version-3.0 card whose FN is derived from the name
     */
    test("serializes a Contact and derives FN", () => {
      const out = serializeContact({
        uid: "NEW-1",
        firstName: "John",
        lastName: "Smith",
        emails: [{ value: "john@smith.com", type: "work" }],
      });
      expect(out).toContain("VERSION:3.0");
      expect(out).toContain("FN:John Smith");
      const round = parseVCard(out);
      expect(round.emails?.[0]?.value).toBe("john@smith.com");
      expect(round.emails?.[0]?.type).toBe("work");
    });

    /**
     * @case A write is a full replace: dropping a field removes it
     * @preconditions A contact parsed from a card, then re-serialized without note/custom
     * @expectedResult The output no longer contains the dropped note or custom field
     */
    test("dropping a field removes it from the output", () => {
      const contact = parseVCard(ICLOUD_VCARD);
      delete contact.note;
      delete contact.custom;
      const out = serializeContact(contact);
      expect(out).not.toContain("NOTE:");
      expect(out).not.toContain("X-CUSTOM-FIELD");
      // Untouched fields are still there.
      expect(out).toContain("EMAIL");
    });

    /**
     * @case Editing the ergonomic `type` overrides the primary TYPE, keeping PREF
     * @preconditions An email read with `type=INTERNET;type=pref`, then type set to "work"
     * @expectedResult The serialized email carries `type=work` and still `type=pref`
     */
    test("editing type overrides the primary TYPE and keeps PREF", () => {
      const contact = parseVCard(
        [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN:X",
          "EMAIL;type=INTERNET;type=pref:a@b.com",
          "END:VCARD",
        ].join("\r\n"),
      );
      contact.emails![0]!.type = "work";
      const out = serializeContact(contact);
      expect(out).toContain("EMAIL;type=work;type=pref:a@b.com");
    });
  });

  describe("escaping & structure", () => {
    /**
     * @case Separators and newlines in text round-trip without corrupting the grammar
     * @preconditions A note containing a comma, semicolon, and newline
     * @expectedResult The re-parsed note equals the original value
     */
    test("escapes and round-trips special characters in text", () => {
      const note = "a, b; c\nd";
      const out = serializeContact({ fullName: "X", note });
      const round = parseVCard(out);
      expect(round.note).toBe(note);
    });

    /**
     * @case Structured component separators are not confused with literal commas
     * @preconditions An organization whose name contains a comma
     * @expectedResult organization round-trips intact; department is unaffected
     */
    test("keeps a comma inside an ORG component", () => {
      const out = serializeContact({
        fullName: "X",
        organization: "Acme, Inc.",
        department: "R&D",
      });
      const round = parseVCard(out);
      expect(round.organization).toBe("Acme, Inc.");
      expect(round.department).toBe("R&D");
    });

    /**
     * @case Long values are folded to <=75 octets without splitting a code point
     * @preconditions A note long enough to fold, containing multibyte characters
     * @expectedResult Every physical line is <=75 octets and the value round-trips
     */
    test("folds long multibyte lines safely", () => {
      const note = "café ".repeat(40);
      const out = serializeContact({ fullName: "X", note });
      for (const line of out.split("\r\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      }
      expect(parseVCard(out).note).toBe(note);
    });
  });

  describe("parse validation", () => {
    /**
     * @case Non-vCard input is rejected
     * @preconditions A string with no BEGIN/END:VCARD
     * @expectedResult parseVCard throws a SyntaxError
     */
    test("rejects input without a VCARD envelope", () => {
      expect(() => parseVCard("not a vcard")).toThrow(SyntaxError);
    });

    /**
     * @case A vCard collection is rejected rather than silently flattened
     * @preconditions Two BEGIN:VCARD blocks in one payload
     * @expectedResult parseVCard throws a SyntaxError
     */
    test("rejects a multi-card collection", () => {
      const two = `${ICLOUD_VCARD}\r\n${ICLOUD_VCARD}`;
      expect(() => parseVCard(two)).toThrow(SyntaxError);
    });

    /**
     * @case The lexer unfolds continuation lines
     * @preconditions A folded NOTE split across two physical lines
     * @expectedResult The record value is rejoined without the fold whitespace
     */
    test("unfolds continuation lines", () => {
      const folded = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "NOTE:hello ",
        " world",
        "END:VCARD",
      ].join("\r\n");
      const note = parseRecords(folded).find((r) => r.name === "note");
      expect(note?.value).toBe("hello world");
    });
  });
});

describe("CardDAV source (read)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case The source emits one Contact per card, carrying url and etag
   * @preconditions A driver returning two cards
   * @expectedResult Two exchanges, each body carrying its url
   */
  test("emits one contact per card", async () => {
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
    const first = s.received[0]?.body as Contact;
    expect(first.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(first.etag).toBe('"1"');
  });

  /**
   * @case The limit option caps how many contacts are emitted
   * @preconditions Two cards available, limit 1
   * @expectedResult Only the first contact is emitted
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
   * @case Enriching pulls all contacts onto the triggering exchange
   * @preconditions A trigger source and a driver returning one card
   * @expectedResult The enriched body carries the fetched contact
   */
  test("enrich returns all contacts", async () => {
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
    const body = s.received[0]?.body as Record<string, Contact>;
    expect(body["0"]?.fullName).toBe("Jane Q Doe");
  });
});

describe("CardDAV destination (write)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case save with no existing url creates a new card
   * @preconditions Empty address book; a new Contact without url
   * @expectedResult createVCard is called with an FN-bearing card; result.created is true
   */
  test("save creates when there is no url", async () => {
    const driver = fakeDriver([]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple<Contact>({ firstName: "Sam", lastName: "Lee" }))
          .to(carddav({ action: "save" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.created).toHaveLength(1);
    expect(driver.created[0]?.vCardString).toContain("FN:Sam Lee");
    const result = s.received[0]?.body as CardDAVWriteResult;
    expect(result.created).toBe(true);
    expect(driver.calls.fetchVCards).toBe(0);
  });

  /**
   * @case update writes to the contact's url with its read-time etag as If-Match
   * @preconditions A card exists; the body carries that url and matching etag
   * @expectedResult updateVCard is called with the url and etag; no address-book fetch happens
   */
  test("update targets url with If-Match and does not refetch", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const contact: Contact = {
      ...parseVCard(ICLOUD_VCARD),
      url: `${BOOK_URL}abc-123.vcf`,
      etag: '"1"',
      note: "updated",
    };

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(contact))
          .to(carddav({ action: "update" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.updated).toHaveLength(1);
    expect(driver.updated[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.updated[0]?.vCard.etag).toBe('"1"');
    expect(driver.calls.fetchVCards).toBe(0);
    expect(driver.calls.fetchBooks).toBe(0);
    const result = s.received[0]?.body as CardDAVWriteResult;
    expect(result.created).toBe(false);
  });

  /**
   * @case A stale etag is rejected by the server precondition (lost-update guard)
   * @preconditions The server card is at etag "2"; the body carries the stale "1"
   * @expectedResult The 412 surfaces as RC5001 rather than silently overwriting
   */
  test("update with a stale etag surfaces a conflict", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"2"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const contact: Contact = {
      ...parseVCard(ICLOUD_VCARD),
      url: `${BOOK_URL}abc-123.vcf`,
      etag: '"1"',
    };

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(contact))
          .to(carddav({ action: "update" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5001")).toBe(true);
  });

  /**
   * @case update without a resolvable url is a hard error
   * @preconditions A Contact with neither url nor headers
   * @expectedResult The route surfaces RC5014
   */
  test("update without a url raises RC5014", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple<Contact>({ firstName: "No", lastName: "Url" }))
          .to(carddav({ action: "update" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });

  /**
   * @case save updates in place when the body carries a url
   * @preconditions A card exists; the body carries its url
   * @expectedResult updateVCard is called, not createVCard
   */
  test("save updates in place when a url is present", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const contact: Contact = {
      ...parseVCard(ICLOUD_VCARD),
      url: `${BOOK_URL}abc-123.vcf`,
      etag: '"1"',
    };

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple(contact))
          .to(carddav({ action: "save" })),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.updated).toHaveLength(1);
    expect(driver.created).toHaveLength(0);
  });

  /**
   * @case save without a url falls back to update when the resource already exists
   * @preconditions A card already exists at uid EXISTS.vcf; body has that uid, no url
   * @expectedResult create returns 412, the adapter locates the card and updates it
   */
  test("save without url updates an existing uid via conflict fallback", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}EXISTS.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(
            simple<Contact>({
              uid: "EXISTS",
              firstName: "Up",
              lastName: "Date",
            }),
          )
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
   * @case A non-object body is rejected
   * @preconditions The exchange body is an array
   * @expectedResult The route surfaces RC5001
   */
  test("rejects a non-Contact body", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple([1, 2, 3] as unknown as Contact))
          .to(carddav({ action: "create" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5001")).toBe(true);
  });
});

describe("CardDAV destination (delete)", () => {
  let t: TestContext;
  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Delete by url targets the resource directly with its etag
   * @preconditions A card exists; body carries its url and etag
   * @expectedResult deleteVCard is called with the url and etag; no fetch happens
   */
  test("deletes by url without refetching", async () => {
    const driver = fakeDriver([
      { url: `${BOOK_URL}abc-123.vcf`, etag: '"1"', data: ICLOUD_VCARD },
    ]);
    CardDAVClientManager.createDriverClient = async () => driver;

    const s = spy();
    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple<Contact>({ url: `${BOOK_URL}abc-123.vcf`, etag: '"1"' }))
          .to(carddav({ action: "delete" }))
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(driver.deleted).toHaveLength(1);
    expect(driver.deleted[0]?.vCard.url).toBe(`${BOOK_URL}abc-123.vcf`);
    expect(driver.deleted[0]?.vCard.etag).toBe('"1"');
    expect(driver.calls.fetchVCards).toBe(0);
    const result = s.received[0]?.body as CardDAVDeleteResult;
    expect(result.deleted).toBe(true);
  });

  /**
   * @case Delete by uid (no url) looks the contact up first
   * @preconditions A card exists; body carries only its uid
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
          .from(simple<Contact>({ uid: "ABC-123" }))
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
   * @preconditions Empty address book; body carries an unknown uid
   * @expectedResult The route surfaces RC5014
   */
  test("delete without a match raises RC5014", async () => {
    CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

    t = await testContext()
      .with(ACCOUNT_CONFIG)
      .routes(
        craft()
          .from(simple<Contact>({ uid: "missing" }))
          .to(carddav({ action: "delete" })),
      )
      .build();
    await t.test();

    expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
  });
});
