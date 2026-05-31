import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, carddav } from "@routecraft/routecraft";
import vCard from "vcf";
import { CardDAVAdapter } from "../src/adapters/carddav/index.ts";
import { CardDAVClientManager } from "../src/adapters/carddav/client-manager.ts";
import { requireClientManager } from "../src/adapters/carddav/shared.ts";
import {
  parseVCard,
  serializeContact,
  patchVCard,
} from "../src/adapters/carddav/vcard-codec.ts";
import type {
  CardDAVDriverClient,
  DAVVCardLike,
} from "../src/adapters/carddav/shared.ts";
import type {
  CardDAVDeleteResult,
  CardDAVWriteResult,
  Contact,
} from "../src/adapters/carddav/types.ts";

// A realistic iCloud-shaped vCard 3.0 export, including a grouped ADR and an
// unmanaged X- property to prove round-trip fidelity.
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
  "item1.ADR;type=HOME;type=pref:;;123 Main St;Springfield;IL;62704;USA",
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

interface FakeDriver extends CardDAVDriverClient {
  created: Array<{ vCardString: string; filename: string }>;
  updated: Array<{ vCard: DAVVCardLike }>;
  deleted: Array<{ vCard: DAVVCardLike }>;
}

function fakeDriver(cards: DAVVCardLike[] = []): FakeDriver {
  const created: FakeDriver["created"] = [];
  const updated: FakeDriver["updated"] = [];
  const deleted: FakeDriver["deleted"] = [];
  return {
    created,
    updated,
    deleted,
    fetchAddressBooks: async () => [
      {
        url: "https://contacts.icloud.com/123/carddavhome/card/",
        displayName: "Card",
      },
    ],
    fetchVCards: async () => cards,
    createVCard: async (p) => {
      created.push({ vCardString: p.vCardString, filename: p.filename });
      return new Response(null, {
        status: 201,
        headers: { etag: '"new-etag"' },
      });
    },
    updateVCard: async (p) => {
      updated.push({ vCard: p.vCard });
      return new Response(null, {
        status: 200,
        headers: { etag: '"upd-etag"' },
      });
    },
    deleteVCard: async (p) => {
      deleted.push({ vCard: p.vCard });
      return new Response(null, { status: 204 });
    },
  };
}

const ORIGINAL_CREATE_DRIVER = CardDAVClientManager.createDriverClient;

afterEach(() => {
  CardDAVClientManager.createDriverClient = ORIGINAL_CREATE_DRIVER;
});

describe("CardDAV adapter", () => {
  describe("vCard codec", () => {
    /**
     * @case Parse a full iCloud vCard 3.0 into a normalized Contact
     * @preconditions A vCard with name, org, email, tel, adr, bday, note, url, photo, and uid
     * @expectedResult Every field maps to the Contact model and raw is preserved
     */
    test("parses all contact fields from an iCloud vCard", () => {
      const contact = parseVCard(vCard, ICLOUD_VCARD);
      expect(contact.uid).toBe("ABC-123");
      expect(contact.fullName).toBe("Jane Q Doe");
      expect(contact.lastName).toBe("Doe");
      expect(contact.firstName).toBe("Jane");
      expect(contact.middleName).toBe("Q");
      expect(contact.organization).toBe("Acme Inc.");
      expect(contact.title).toBe("Engineer");
      expect(contact.emails?.[0]?.value).toBe("jane@example.com");
      expect(contact.phones?.[0]?.value).toBe("+15551234567");
      expect(contact.addresses?.[0]?.street).toBe("123 Main St");
      expect(contact.addresses?.[0]?.city).toBe("Springfield");
      expect(contact.addresses?.[0]?.postalCode).toBe("62704");
      expect(contact.birthday).toBe("1990-05-21");
      expect(contact.note).toBe("Met at the conference.");
      expect(contact.urls?.[0]).toBe("https://jane.example.com");
      expect(contact.photo?.data).toContain("/9j/");
      expect(contact.photo?.mediaType).toBe("JPEG");
      expect(contact.raw).toBe(ICLOUD_VCARD);
    });

    /**
     * @case Serialize a Contact into a valid vCard 3.0
     * @preconditions A contact with name, email, birthday, and uid but no fullName
     * @expectedResult A version-3.0 card that re-parses to the same fields, with FN derived
     */
    test("serializes a Contact into a re-parseable vCard", () => {
      const out = serializeContact({
        uid: "NEW-1",
        firstName: "John",
        lastName: "Smith",
        emails: [{ value: "john@smith.com", type: "work" }],
        birthday: "1985-01-02",
      });
      expect(out).toContain("VERSION:3.0");
      const round = parseVCard(vCard, out);
      expect(round.uid).toBe("NEW-1");
      expect(round.fullName).toBe("John Smith");
      expect(round.lastName).toBe("Smith");
      expect(round.emails?.[0]?.value).toBe("john@smith.com");
      expect(round.birthday).toBe("1985-01-02");
    });

    /**
     * @case Partial update preserves unmanaged and untouched vCard fields
     * @preconditions Patch an existing card with only a new birthday
     * @expectedResult Birthday changes; X- field, email, and note are retained
     */
    test("patch preserves fields the Contact model does not touch", () => {
      const patched = patchVCard(ICLOUD_VCARD, {
        birthday: "2001-02-03",
      });
      expect(patched).toContain("X-CUSTOM-FIELD:keepme");
      const round = parseVCard(vCard, patched);
      expect(round.birthday).toBe("2001-02-03");
      expect(round.emails?.[0]?.value).toBe("jane@example.com");
      expect(round.note).toBe("Met at the conference.");
      expect(round.fullName).toBe("Jane Q Doe");
    });
  });

  describe("update fidelity & custom fields", () => {
    // A complex iCloud card: grouped phone label, social profile, a labeled
    // date, a related name, and a custom X- field.
    const RICH = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//Apple Inc.//iOS 17//EN",
      "N:Doe;Jane;;;",
      "FN:Jane Doe",
      "NICKNAME:Janie",
      "item1.TEL;type=CELL:+15551234567",
      "item1.X-ABLabel:_$!<MyCustomLabel>!$_",
      "X-SOCIALPROFILE;type=twitter:https://twitter.com/jane",
      "item2.X-ABDATE;type=pref:2010-06-01",
      "item2.X-ABLabel:Anniversary",
      "X-ABRELATEDNAMES;type=pref:John",
      "CATEGORIES:Friends,VIP",
      "X-FOO:keepme",
      "UID:ABC-123",
      "END:VCARD",
    ].join("\r\n");

    /**
     * @case Updating one field never corrupts or drops unmanaged properties
     * @preconditions A rich iCloud card; patch only the note
     * @expectedResult Every other line survives byte-for-byte; the note is added
     */
    test("update preserves every unmanaged line verbatim", () => {
      const out = patchVCard(RICH, { note: "hello world" });
      // Lines that must survive exactly as written.
      for (const line of [
        "PRODID:-//Apple Inc.//iOS 17//EN",
        "NICKNAME:Janie",
        "item1.TEL;type=CELL:+15551234567",
        "item1.X-ABLabel:_$!<MyCustomLabel>!$_",
        "X-SOCIALPROFILE;type=twitter:https://twitter.com/jane",
        "item2.X-ABDATE;type=pref:2010-06-01",
        "item2.X-ABLabel:Anniversary",
        "X-ABRELATEDNAMES;type=pref:John",
        "CATEGORIES:Friends,VIP",
      ]) {
        expect(out).toContain(line);
      }
      expect(out).toContain("NOTE:hello world");
      // No casing corruption of custom names.
      expect(out).not.toContain("X-AB-LABEL");
      expect(out).not.toContain("TYPE=TWITTER");
    });

    /**
     * @case Replacing a grouped multi-valued field drops its orphaned label
     * @preconditions A phone grouped with item1.X-ABLabel; patch replaces phones
     * @expectedResult Old TEL and its grouped label are gone; new TEL present
     */
    test("replacing phones removes the orphaned grouped label", () => {
      const out = patchVCard(RICH, {
        phones: [{ value: "+19998887777", type: "home" }],
      });
      expect(out).not.toContain("+15551234567");
      expect(out).not.toContain("item1.X-ABLabel:_$!<MyCustomLabel>!$_");
      expect(out).toContain("TEL;TYPE=HOME:+19998887777");
      // An unrelated group survives.
      expect(out).toContain("item2.X-ABDATE;type=pref:2010-06-01");
    });

    /**
     * @case Labeled dates and unmodeled custom fields are read into the model
     * @preconditions A card with X-ABDATE/X-ABLabel and an X-FOO property
     * @expectedResult dates[] holds the date; custom[] holds the X- field
     */
    test("parse exposes labeled dates and unmodeled custom fields", () => {
      const contact = parseVCard(vCard, RICH);
      expect(contact.dates).toContainEqual({
        label: "Anniversary",
        date: "2010-06-01",
      });
      const foo = contact.custom?.find((f) => f.key === "X-FOO");
      expect(foo?.value).toBe("keepme");
    });

    /**
     * @case Unmodeled custom fields and dates round-trip through create
     * @preconditions A new Contact carrying an X- field and a labeled date
     * @expectedResult The serialized card carries both, and re-parses to them
     */
    test("create writes custom fields and labeled dates", () => {
      const out = serializeContact({
        uid: "NEW-9",
        fullName: "Sam Lee",
        custom: [{ key: "X-FOO", value: "bar" }],
        dates: [{ label: "Graduation", date: "2015-06-15" }],
      });
      const round = parseVCard(vCard, out);
      expect(round.dates).toContainEqual({
        label: "Graduation",
        date: "2015-06-15",
      });
      expect(round.custom?.find((f) => f.key === "X-FOO")?.value).toBe("bar");
    });

    /**
     * @case Updating a custom field upserts it without dropping other data
     * @preconditions A card with an X-FOO custom field; patch updates it by key
     * @expectedResult The targeted field changes; unrelated lines are untouched
     */
    test("custom update upserts by key and keeps the rest", () => {
      const out = patchVCard(RICH, {
        custom: [{ key: "X-FOO", value: "updated" }],
      });
      expect(out).toContain("X-FOO:updated");
      expect(out).not.toContain("X-FOO:keepme");
      // Unrelated properties are left alone.
      expect(out).toContain(
        "X-SOCIALPROFILE;type=twitter:https://twitter.com/jane",
      );
    });
  });

  describe("structured iCloud fields", () => {
    const FIELDS = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Doe;Jane;;;",
      "FN:Jane Doe",
      "NICKNAME:Janie",
      "ORG:Acme Inc.;Engineering",
      "CATEGORIES:Friends,VIP",
      "IMPP;X-SERVICE-TYPE=iMessage:imessage:jane@x.com",
      "X-SOCIALPROFILE;type=twitter:https://twitter.com/jane",
      "item1.X-ABRELATEDNAMES;type=pref:John",
      "item1.X-ABLabel:_$!<Spouse>!$_",
      "UID:ABC-123",
      "END:VCARD",
    ].join("\r\n");

    /**
     * @case Nickname, department, categories, IM, social, and related names parse
     * @preconditions A card carrying each iCloud-specific property
     * @expectedResult Each maps to its Contact field and is excluded from custom
     */
    test("parses the structured iCloud fields", () => {
      const c = parseVCard(vCard, FIELDS);
      expect(c.nickname).toBe("Janie");
      expect(c.organization).toBe("Acme Inc.");
      expect(c.department).toBe("Engineering");
      expect(c.categories).toEqual(["Friends", "VIP"]);
      expect(c.instantMessages).toEqual([
        { service: "iMessage", handle: "jane@x.com" },
      ]);
      expect(c.socialProfiles).toEqual([
        { service: "twitter", url: "https://twitter.com/jane" },
      ]);
      expect(c.relatedNames).toEqual([{ label: "Spouse", name: "John" }]);
      // Modeled fields must not leak into the custom passthrough.
      expect(c.custom).toBeUndefined();
    });

    /**
     * @case The structured fields round-trip through create
     * @preconditions A new Contact carrying each field
     * @expectedResult The serialized card re-parses to the same values
     */
    test("creates and re-parses the structured fields", () => {
      const out = serializeContact({
        uid: "NEW-1",
        fullName: "Sam Lee",
        nickname: "Sammy",
        organization: "Beta",
        department: "Sales",
        categories: ["work"],
        instantMessages: [{ service: "WhatsApp", handle: "+15551112222" }],
        socialProfiles: [
          { service: "linkedin", url: "https://linkedin.com/in/sam" },
        ],
        relatedNames: [{ label: "manager", name: "Dana" }],
      });
      const r = parseVCard(vCard, out);
      expect(r.nickname).toBe("Sammy");
      expect(r.organization).toBe("Beta");
      expect(r.department).toBe("Sales");
      expect(r.categories).toEqual(["work"]);
      expect(r.instantMessages).toEqual([
        { service: "WhatsApp", handle: "+15551112222" },
      ]);
      expect(r.socialProfiles).toEqual([
        { service: "linkedin", url: "https://linkedin.com/in/sam" },
      ]);
      expect(r.relatedNames).toEqual([{ label: "manager", name: "Dana" }]);
    });

    /**
     * @case Updating department keeps the existing company (and vice versa)
     * @preconditions ORG has company and department; patch only the department
     * @expectedResult ORG keeps the company; the department changes
     */
    test("updating department preserves the company component", () => {
      const out = patchVCard(FIELDS, { department: "Research" });
      expect(out).toContain("ORG:Acme Inc.;Research");
    });

    /**
     * @case Replacing related names drops the old grouped relationship label
     * @preconditions A related name grouped with item1.X-ABLabel
     * @expectedResult The old value and its label are gone; the new pair present
     */
    test("replacing related names removes the orphaned label", () => {
      const out = patchVCard(FIELDS, {
        relatedNames: [{ label: "child", name: "Alex" }],
      });
      expect(out).not.toContain("X-ABRELATEDNAMES;type=pref:John");
      expect(out).not.toContain("item1.X-ABLabel:_$!<Spouse>!$_");
      expect(out).toContain("X-ABRELATEDNAMES:Alex");
      expect(out).toContain("X-ABLabel:child");
    });
  });

  describe("encoding & robustness", () => {
    /**
     * @case A component containing an escaped semicolon round-trips intact
     * @preconditions ORG company component contains `\;`; update an unrelated field
     * @expectedResult organization/department parse correctly and survive the merge
     */
    test("structured components with an escaped semicolon round-trip", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Co",
        "ORG:Acme\\; Inc.;Sales",
        "UID:X",
        "END:VCARD",
      ].join("\r\n");
      const c = parseVCard(vCard, card);
      expect(c.organization).toBe("Acme; Inc.");
      expect(c.department).toBe("Sales");
      // Updating the department must preserve the company component verbatim.
      const out = patchVCard(card, { department: "Research" });
      const r = parseVCard(vCard, out);
      expect(r.organization).toBe("Acme; Inc.");
      expect(r.department).toBe("Research");
    });

    /**
     * @case Create emits each property once, with no duplicates
     * @preconditions A Contact that sets every modeled field
     * @expectedResult Single ORG/CATEGORIES/NICKNAME/FN lines and one BEGIN/END
     */
    test("create emits no duplicate property lines", () => {
      const out = serializeContact({
        uid: "U",
        firstName: "A",
        lastName: "B",
        nickname: "AB",
        organization: "Org",
        department: "Dept",
        title: "T",
        categories: ["x"],
        note: "n",
        birthday: "2000-01-01",
        phones: [{ value: "1" }],
        emails: [{ value: "a@b.com" }],
        urls: ["http://x"],
        addresses: [{ city: "C" }],
        instantMessages: [{ service: "iMessage", handle: "h" }],
        socialProfiles: [{ service: "twitter", url: "http://t" }],
        relatedNames: [{ label: "spouse", name: "S" }],
        dates: [{ label: "anniversary", date: "2001-01-01" }],
        custom: [{ key: "X-FOO", value: "bar" }],
      });
      const count = (prefix: string): number =>
        out.split("\r\n").filter((l) => l.startsWith(prefix)).length;
      for (const prefix of [
        "BEGIN:VCARD",
        "END:VCARD",
        "FN:",
        "ORG:",
        "CATEGORIES:",
        "NICKNAME:",
      ]) {
        expect(count(prefix)).toBe(1);
      }
    });

    /**
     * @case Parameter values with special characters are quoted
     * @preconditions A social profile whose service contains a semicolon
     * @expectedResult The emitted param value is double-quoted per RFC 6350
     */
    test("parameter values with special characters are quoted", () => {
      const out = serializeContact({
        uid: "U",
        fullName: "X",
        socialProfiles: [{ service: "we;ird", url: "http://x" }],
      });
      expect(out).toContain('X-SOCIALPROFILE;type="we;ird":http://x');
    });

    /**
     * @case Long multibyte values fold to <=75 octets per physical line
     * @preconditions A note of 100 two-byte characters
     * @expectedResult Every physical line is <=75 octets and the value round-trips
     */
    test("long multibyte values fold to <=75 octets per line", () => {
      const long = "é".repeat(100);
      const out = serializeContact({ uid: "U", fullName: "X", note: long });
      for (const line of out.split("\r\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      }
      expect(parseVCard(vCard, out).note).toBe(long);
    });

    /**
     * @case Quoted parameter values containing separators parse correctly
     * @preconditions A param value quoted around `;` and `:`
     * @expectedResult The header boundary and param split honor the quotes
     */
    test("parses quoted parameter values containing separators", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Q",
        'X-SOCIALPROFILE;type="we;ir:d":https://x.com/q',
        "UID:Q1",
        "END:VCARD",
      ].join("\r\n");
      const c = parseVCard(vCard, card);
      expect(c.socialProfiles?.[0]?.service).toBe("we;ir:d");
      expect(c.socialProfiles?.[0]?.url).toBe("https://x.com/q");
    });

    /**
     * @case A param value needing quotes round-trips through create and parse
     * @preconditions A social-profile service containing a semicolon
     * @expectedResult The serialized card quotes the param and re-parses to it
     */
    test("quoted param values round-trip through create and parse", () => {
      const out = serializeContact({
        uid: "U",
        fullName: "X",
        socialProfiles: [{ service: "we;ird", url: "https://x" }],
      });
      const r = parseVCard(vCard, out);
      expect(r.socialProfiles?.[0]?.service).toBe("we;ird");
      expect(r.socialProfiles?.[0]?.url).toBe("https://x");
    });
  });

  describe("factory", () => {
    /**
     * @case carddav() returns an adapter usable as both source and destination
     * @preconditions Called with no arguments
     * @expectedResult Instance of CardDAVAdapter exposing subscribe and send
     */
    test("carddav() returns a dual-role adapter", () => {
      const adapter = carddav();
      expect(adapter).toBeInstanceOf(CardDAVAdapter);
      expect(adapter).toHaveProperty("subscribe");
      expect(adapter).toHaveProperty("send");
      expect((adapter as CardDAVAdapter).adapterId).toBe(
        "routecraft.adapter.carddav",
      );
    });
  });

  describe("client manager", () => {
    /**
     * @case Missing carddav config surfaces a clear misconfiguration error
     * @preconditions No client manager in the context
     * @expectedResult requireClientManager throws RC5003
     */
    test("requireClientManager throws RC5003 without config", () => {
      expect(() => requireClientManager(undefined)).toThrow(/RC5003|carddav/);
    });

    /**
     * @case A login failure maps to an authentication error
     * @preconditions createDriverClient rejects with a 401 message
     * @expectedResult getClient rejects with RC5012
     */
    test("maps a 401 login failure to RC5012", async () => {
      CardDAVClientManager.createDriverClient = async () => {
        throw new Error("401 Unauthorized");
      };
      const manager = new CardDAVClientManager(ACCOUNT_CONFIG.carddav);
      let rc: string | undefined;
      try {
        await manager.getClient();
      } catch (error) {
        rc = (error as { rc?: string }).rc;
      }
      expect(rc).toBe("RC5012");
    });
  });

  describe("source (read)", () => {
    let t: TestContext;
    afterEach(async () => {
      if (t) await t.stop();
    });

    /**
     * @case Reading emits one Contact per vCard in the address book
     * @preconditions The driver returns two vCards
     * @expectedResult The route receives two contacts, each carrying its DAV url
     */
    test("emits one contact per vCard", async () => {
      CardDAVClientManager.createDriverClient = async () =>
        fakeDriver([
          {
            url: "https://dav/card/abc-123.vcf",
            etag: '"1"',
            data: ICLOUD_VCARD,
          },
          {
            url: "https://dav/card/def-456.vcf",
            etag: '"2"',
            data: ICLOUD_VCARD.replace("ABC-123", "DEF-456").replace(
              "Jane Q Doe",
              "John Roe",
            ),
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
      expect(first.fullName).toBe("Jane Q Doe");
      expect(first.url).toBe("https://dav/card/abc-123.vcf");
    });

    /**
     * @case The limit option caps how many contacts are emitted
     * @preconditions Two vCards available, limit set to 1
     * @expectedResult Only the first contact is emitted
     */
    test("honors the limit option", async () => {
      CardDAVClientManager.createDriverClient = async () =>
        fakeDriver([
          { url: "https://dav/card/a.vcf", data: ICLOUD_VCARD },
          { url: "https://dav/card/b.vcf", data: ICLOUD_VCARD },
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

      expect(t.errors).toHaveLength(0);
      expect(s.received).toHaveLength(1);
    });

    /**
     * @case The emitted UID header comes from the vCard, not the filename
     * @preconditions A card whose resource filename differs from its vCard UID
     * @expectedResult routecraft.carddav.uid is the vCard UID (ABC-123)
     */
    test("emits the vCard UID header, not the filename", async () => {
      CardDAVClientManager.createDriverClient = async () =>
        fakeDriver([
          {
            url: "https://dav/card/not-the-uid.vcf",
            etag: '"1"',
            data: ICLOUD_VCARD,
          },
        ]);

      const s = spy();
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(craft().from(carddav()).to(s))
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(s.received[0]?.headers["routecraft.carddav.uid"]).toBe("ABC-123");
    });
  });

  describe("destination (write)", () => {
    let t: TestContext;
    afterEach(async () => {
      if (t) await t.stop();
    });

    /**
     * @case Writing a contact with no match creates a new vCard
     * @preconditions Address book is empty; body is a new Contact without uid
     * @expectedResult createVCard is called with an FN-bearing card; result.created is true
     */
    test("creates a new contact", async () => {
      const driver = fakeDriver([]);
      CardDAVClientManager.createDriverClient = async () => driver;

      const s = spy();
      const newContact: Contact = {
        firstName: "Sam",
        lastName: "Lee",
        emails: [{ value: "sam@lee.com", type: "work" }],
        birthday: "1992-03-04",
      };
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple(newContact))
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
      expect(result.uid.length).toBeGreaterThan(0);
    });

    /**
     * @case Upserting a contact that exists updates it and keeps unmanaged fields
     * @preconditions A vCard with uid ABC-123 exists; body updates only the birthday
     * @expectedResult updateVCard is called; the patched card keeps the X- field; result.created is false
     */
    test("updates an existing contact and preserves unmanaged fields", async () => {
      const driver = fakeDriver([
        {
          url: "https://dav/card/abc-123.vcf",
          etag: '"1"',
          data: ICLOUD_VCARD,
        },
      ]);
      CardDAVClientManager.createDriverClient = async () => driver;

      const s = spy();
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple<Contact>({ uid: "ABC-123", birthday: "2001-02-03" }))
            .to(carddav({ action: "save" }))
            .to(s),
        )
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(driver.updated).toHaveLength(1);
      expect(driver.created).toHaveLength(0);
      const sent = String(driver.updated[0]?.vCard.data);
      expect(sent).toContain("BDAY:2001-02-03");
      expect(sent).toContain("X-CUSTOM-FIELD:keepme");
      const result = s.received[0]?.body as CardDAVWriteResult;
      expect(result.created).toBe(false);
    });

    /**
     * @case The write result UID is read from the vCard, not the filename
     * @preconditions The matched card's resource filename differs from its UID
     * @expectedResult result.uid is the vCard UID (ABC-123)
     */
    test("save result uses the vCard UID, not the filename", async () => {
      const driver = fakeDriver([
        {
          url: "https://dav/card/not-the-uid.vcf",
          etag: '"1"',
          data: ICLOUD_VCARD,
        },
      ]);
      CardDAVClientManager.createDriverClient = async () => driver;

      const s = spy();
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(
              simple<Contact>({
                url: "https://dav/card/not-the-uid.vcf",
                birthday: "2002-02-02",
              }),
            )
            .to(carddav({ action: "save" }))
            .to(s),
        )
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(driver.updated).toHaveLength(1);
      const result = s.received[0]?.body as CardDAVWriteResult;
      expect(result.created).toBe(false);
      expect(result.uid).toBe("ABC-123");
    });

    /**
     * @case update action with no match is a hard error
     * @preconditions Address book is empty; action is "update"; body has a uid
     * @expectedResult The route surfaces RC5014
     */
    test("update action without a match raises RC5014", async () => {
      CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple<Contact>({ uid: "missing", note: "x" }))
            .to(carddav({ action: "update" })),
        )
        .build();
      await t.test();

      expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
    });
  });

  describe("enrich (fetch-all)", () => {
    let t: TestContext;
    afterEach(async () => {
      if (t) await t.stop();
    });

    /**
     * @case Enriching pulls all contacts onto the triggering exchange
     * @preconditions A trigger source and a driver returning one vCard
     * @expectedResult The enriched body carries the fetched Contact (numeric-key spread)
     */
    test("enrich returns all contacts as an array", async () => {
      CardDAVClientManager.createDriverClient = async () =>
        fakeDriver([
          {
            url: "https://dav/card/abc-123.vcf",
            etag: '"1"',
            data: ICLOUD_VCARD,
          },
        ]);

      const s = spy();
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(craft().from(simple("trigger")).enrich(carddav()).to(s))
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(s.received).toHaveLength(1);
      // The default enrich aggregator spreads the array onto the body.
      const body = s.received[0]?.body as Record<string, Contact>;
      expect(body["0"]?.fullName).toBe("Jane Q Doe");
      expect(body["0"]?.url).toBe("https://dav/card/abc-123.vcf");
    });
  });

  describe("destination (delete)", () => {
    let t: TestContext;
    afterEach(async () => {
      if (t) await t.stop();
    });

    /**
     * @case Deleting removes the contact resolved from the body
     * @preconditions A matching vCard exists; body carries its url
     * @expectedResult deleteVCard is called with the matching url; result.deleted is true
     */
    test("deletes a contact by url", async () => {
      const driver = fakeDriver([
        {
          url: "https://dav/card/abc-123.vcf",
          etag: '"1"',
          data: ICLOUD_VCARD,
        },
      ]);
      CardDAVClientManager.createDriverClient = async () => driver;

      const s = spy();
      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple<Contact>({ url: "https://dav/card/abc-123.vcf" }))
            .to(carddav({ action: "delete" }))
            .to(s),
        )
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(driver.deleted).toHaveLength(1);
      expect(driver.deleted[0]?.vCard.url).toBe("https://dav/card/abc-123.vcf");
      const result = s.received[0]?.body as CardDAVDeleteResult;
      expect(result.deleted).toBe(true);
    });

    /**
     * @case delete with no matching contact is a hard error
     * @preconditions Address book is empty; body carries an unknown url
     * @expectedResult The route surfaces RC5014
     */
    test("delete without a match raises RC5014", async () => {
      CardDAVClientManager.createDriverClient = async () => fakeDriver([]);

      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple<Contact>({ url: "https://dav/card/missing.vcf" }))
            .to(carddav({ action: "delete" })),
        )
        .build();
      await t.test();

      expect(t.errors.some((e) => e.rc === "RC5014")).toBe(true);
    });
  });
});
