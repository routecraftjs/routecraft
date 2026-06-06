import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, carddav } from "@routecraft/routecraft";
import { CardDAVAdapter } from "../src/adapters/carddav/index.ts";
import { CardDAVClientManager } from "../src/adapters/carddav/client-manager.ts";
import { requireClientManager } from "../src/adapters/carddav/shared.ts";
import {
  parseVCard,
  serializeContact,
  patchVCard,
} from "../src/adapters/carddav/vcard-codec.ts";
import {
  extractCustomFields,
  parseRecords,
  withChanges,
} from "../src/adapters/carddav/vcard-raw.ts";
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
      const contact = parseVCard(ICLOUD_VCARD);
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
      const round = parseVCard(out);
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
      const round = parseVCard(patched);
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
      // Caller-supplied TYPE case is preserved verbatim so a round-tripped
      // Apple label like `iPhone` is not corrupted into `IPHONE`.
      expect(out).toContain("TEL;TYPE=home:+19998887777");
      // An unrelated group survives.
      expect(out).toContain("item2.X-ABDATE;type=pref:2010-06-01");
    });

    /**
     * @case Labeled dates and unmodeled custom fields are read into the model
     * @preconditions A card with X-ABDATE/X-ABLabel and an X-FOO property
     * @expectedResult dates[] holds the date; custom[] holds the X- field
     */
    test("parse exposes labeled dates and unmodeled custom fields", () => {
      const contact = parseVCard(RICH);
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
      const round = parseVCard(out);
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
      const c = parseVCard(FIELDS);
      expect(c.nickname).toBe("Janie");
      expect(c.organization).toBe("Acme Inc.");
      expect(c.department).toBe("Engineering");
      expect(c.categories).toEqual(["Friends", "VIP"]);
      // `scheme` is read from the IMPP URI prefix and exposed so a non-Apple
      // scheme (xmpp, skype, tel, ...) survives a round trip on write-back.
      expect(c.instantMessages).toEqual([
        { service: "iMessage", scheme: "imessage", handle: "jane@x.com" },
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
      const r = parseVCard(out);
      expect(r.nickname).toBe("Sammy");
      expect(r.organization).toBe("Beta");
      expect(r.department).toBe("Sales");
      expect(r.categories).toEqual(["work"]);
      expect(r.instantMessages).toEqual([
        { service: "WhatsApp", scheme: "whatsapp", handle: "+15551112222" },
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

  describe("audit-finding regressions (record-level diff/merge)", () => {
    /**
     * @case Audit #1 — ADR extended-address component (index 1) survives patch
     * @preconditions ADR carries `Apt 4B` at index 1; patch leaves addresses untouched
     * @expectedResult The patched card still contains `Apt 4B`
     */
    test("ADR extended-address component is preserved on round-trip", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:E",
        "ADR;TYPE=HOME:;Apt 4B;123 Main St;Springfield;IL;62704;USA",
        "UID:E1",
        "END:VCARD",
      ].join("\r\n");
      // Patch only the note: addresses are not touched at all, so the entire
      // ADR record (including the extended-address slot) must survive byte-
      // for-byte.
      const noteOnly = patchVCard(card, { note: "hi" });
      expect(noteOnly).toContain(
        "ADR;TYPE=HOME:;Apt 4B;123 Main St;Springfield;IL;62704;USA",
      );
      // And: round-tripping the parsed contact through patch keeps Apt 4B even
      // though the model does not expose it as a typed field. The patcher
      // overlays only the components the user explicitly set on top of the
      // origin record's raw components.
      const parsed = parseVCard(card);
      const out = patchVCard(card, { addresses: parsed.addresses });
      expect(out).toContain(";Apt 4B;");
    });

    /**
     * @case Audit #2 — IMPP URI scheme is preserved when no X-SERVICE-TYPE param exists
     * @preconditions A standards-compliant `IMPP:xmpp:alice@host`
     * @expectedResult The xmpp scheme survives a round trip; it is NOT rewritten as `x-apple:`
     */
    test("IMPP URI scheme is preserved without X-SERVICE-TYPE", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:M",
        "IMPP:xmpp:alice@jabber.example",
        "UID:M1",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      expect(parsed.instantMessages).toEqual([
        { scheme: "xmpp", handle: "alice@jabber.example" },
      ]);
      const out = patchVCard(card, {
        instantMessages: parsed.instantMessages,
      });
      expect(out).toContain("IMPP:xmpp:alice@jabber.example");
      expect(out).not.toContain("x-apple:alice@jabber.example");
    });

    /**
     * @case Audit #3 — vCard 3.0 multi-instance `TYPE=HOME;TYPE=PREF` keeps the PREF flag
     * @preconditions TEL carries both TYPE=HOME and TYPE=PREF; patch touches an unrelated field
     * @expectedResult The PREF flag survives the round trip
     */
    test("TEL with TYPE=HOME;TYPE=PREF keeps the PREF flag on patch", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:P",
        "TEL;TYPE=HOME;TYPE=PREF:+15555551212",
        "UID:P1",
        "END:VCARD",
      ].join("\r\n");
      // Touch nothing in `phones` — the entire TEL record (incl. the second
      // TYPE=PREF param) must survive byte-for-byte.
      const noteOnly = patchVCard(card, { note: "x" });
      expect(noteOnly).toContain("TEL;TYPE=HOME;TYPE=PREF:+15555551212");
      // And: round-tripping the read phones through patch also preserves the
      // PREF flag, because the per-record merger only updates the TYPE param
      // when the user-supplied type differs from the origin's first non-pref
      // value (both `home` here).
      const parsed = parseVCard(card);
      const out = patchVCard(card, { phones: parsed.phones });
      expect(out).toContain("TEL;TYPE=HOME;TYPE=PREF:+15555551212");
    });

    /**
     * @case Audit #4 — non-TYPE params on modeled properties survive patch
     * @preconditions EMAIL with X-ABLABEL and a secondary TYPE=INTERNET; touch only the value
     * @expectedResult The X-ABLABEL and INTERNET TYPE survive byte-for-byte
     */
    test("non-TYPE params on a modeled property are preserved on patch", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:E",
        "EMAIL;TYPE=INTERNET;TYPE=HOME;X-ABLABEL=Personal:a@b.com",
        "UID:E1",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      // `withChanges` preserves the origin back-ref through an in-place edit;
      // a plain `{...e, value: ...}` spread would lose it, and the patcher
      // would fall back to value-equality matching (which fails when both the
      // ref AND the value change in the same edit).
      const newEmails = parsed.emails!.map((e) =>
        e.value === "a@b.com" ? withChanges(e, { value: "alice@b.com" }) : e,
      );
      const out = patchVCard(card, { emails: newEmails });
      // The new value is written, and the original params (X-ABLABEL,
      // TYPE=INTERNET) survive because the patcher rewrites only the value
      // bytes inside the origin record.
      expect(out).toContain("alice@b.com");
      expect(out).toContain("X-ABLABEL=Personal");
      expect(out).toContain("TYPE=INTERNET");
    });

    /**
     * @case Audit #5 — group prefix on a modeled property survives patch
     * @preconditions item1.ADR with an item1.X-ABLabel sibling; touch only the city
     * @expectedResult item1 prefix and its X-ABLabel both survive
     */
    test("group prefix on a modeled property is preserved on value edit", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:G",
        "item1.ADR;TYPE=HOME:;;100 Old St;Springfield;IL;62704;USA",
        "item1.X-ABLabel:_$!<Home Address>!$_",
        "UID:G1",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      const newAddresses = parsed.addresses!.map((a) =>
        withChanges(a, { city: "Chicago" }),
      );
      const out = patchVCard(card, { addresses: newAddresses });
      // New city written; group prefix on ADR survives; X-ABLabel sibling
      // (sharing item1 group, NOT in `replaceNames`-style sets) survives.
      expect(out).toContain("Chicago");
      expect(out).toContain("item1.ADR");
      expect(out).toContain("item1.X-ABLabel:_$!<Home Address>!$_");
    });

    /**
     * @case Removing one phone keeps the others byte-for-byte
     * @preconditions Two TELs with rich params; user removes one
     * @expectedResult The kept phone preserves every param; the removed one is gone
     */
    test("removing one phone keeps the other's params byte-for-byte", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:R",
        "item1.TEL;TYPE=CELL;TYPE=PREF:+15551111111",
        "item1.X-ABLabel:_$!<Personal>!$_",
        "TEL;TYPE=WORK:+15552222222",
        "UID:R1",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      // Keep only the WORK phone.
      const kept = parsed.phones!.filter((p) => p.value === "+15552222222");
      const out = patchVCard(card, { phones: kept });
      // Removed phone and its labeled sibling are both gone.
      expect(out).not.toContain("+15551111111");
      expect(out).not.toContain("Personal");
      // Kept phone preserves its TYPE param exactly.
      expect(out).toContain("TEL;TYPE=WORK:+15552222222");
    });

    /**
     * @case IMPP value-equality matching pairs the handle, not the URI
     * @preconditions IMPP origin holds `xmpp:a@b`; the new item carries only the bare handle
     * @expectedResult The patcher rewrites the origin (preserving the xmpp scheme) instead of appending a fresh record
     */
    test("IMPP value-equality matches handle against URI's handle portion", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:I",
        "IMPP:xmpp:alice@jabber.example",
        "UID:I1",
        "END:VCARD",
      ].join("\r\n");
      // Construct a new IM from scratch (no origin ref) with the same handle.
      // Value-equality must pair it against the existing IMPP record so the
      // origin's URI scheme is preserved on update.
      const out = patchVCard(card, {
        instantMessages: [{ handle: "alice@jabber.example" }],
      });
      const imppLines = out
        .split(/\r?\n/)
        .filter((line) => line.startsWith("IMPP"));
      expect(imppLines).toHaveLength(1);
      expect(imppLines[0]).toBe("IMPP:xmpp:alice@jabber.example");
    });

    /**
     * @case parseVCard rejects multi-card payloads
     * @preconditions Input contains two BEGIN:VCARD / END:VCARD blocks
     * @expectedResult parseVCard throws SyntaxError instead of silently flattening
     */
    test("parseVCard rejects vCard collections", () => {
      const payload = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:A",
        "END:VCARD",
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:B",
        "END:VCARD",
      ].join("\r\n");
      expect(() => parseVCard(payload)).toThrow(SyntaxError);
    });

    /**
     * @case Empty-string text singletons are a safe no-op (do not wipe iCloud data)
     * @preconditions Existing card has `FN:Original`; user passes `fullName: ""`
     * @expectedResult The original FN survives; no `FN:` line is emitted
     */
    test("empty-string text singleton is a no-op, not a wipe", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Original Name",
        "UID:W1",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, { fullName: "   " });
      expect(out).toContain("FN:Original Name");
      // No bare-empty FN/UID lines that iCloud would reject.
      expect(out).not.toMatch(/^FN:\s*$/m);
    });

    /**
     * @case N component slots beyond the standard five survive
     * @preconditions N has 7 components (non-standard exporter)
     * @expectedResult Patching an unrelated field keeps every component
     */
    test("N components past the standard 5 are preserved on patch", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Smith",
        "N:Smith;John;Q;Mr.;Jr.;extra6;extra7",
        "UID:N1",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, { firstName: "Jonathan" });
      expect(out).toContain("N:Smith;Jonathan;Q;Mr.;Jr.;extra6;extra7");
    });

    /**
     * @case IMPP with empty-string scheme falls through to the origin/default
     * @preconditions Existing IMPP carries `xmpp:` scheme; new item has `scheme: ""`
     * @expectedResult The xmpp scheme is preserved (no invalid `:handle` URI emitted)
     */
    test("IMPP empty-string scheme is treated as unset", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:I",
        "IMPP:xmpp:alice@jabber.example",
        "UID:I2",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, {
        instantMessages: [{ handle: "alice@jabber.example", scheme: "" }],
      });
      expect(out).toContain("IMPP:xmpp:alice@jabber.example");
      expect(out).not.toContain("IMPP::alice@jabber.example");
    });

    /**
     * @case IMPP whitespace-only scheme is treated as unset
     * @preconditions Existing IMPP carries `xmpp:` scheme; new item has `scheme: "   "`
     * @expectedResult The xmpp scheme is preserved; no `   :handle` URI emitted (RFC 3986 forbids whitespace in schemes)
     */
    test("IMPP whitespace-only scheme is treated as unset", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:I",
        "IMPP:xmpp:alice@jabber.example",
        "UID:I3",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, {
        instantMessages: [{ handle: "alice@jabber.example", scheme: "   " }],
      });
      expect(out).toContain("IMPP:xmpp:alice@jabber.example");
      expect(out).not.toMatch(/IMPP:\s+:alice@jabber\.example/);
    });

    /**
     * @case Mixed-case user TYPE does not force unnecessary header rewrite
     * @preconditions Origin stores `TYPE=HOME` (parsed to lowercase `home`); user supplies `type: "HOME"`
     * @expectedResult The header survives byte-for-byte (no rewritten TYPE param)
     */
    test("mixed-case user TYPE matches lowercased origin without rewriting header", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:T",
        "TEL;TYPE=HOME;X-CUSTOM=keep:+15551111111",
        "UID:T1",
        "END:VCARD",
      ].join("\r\n");
      // User passes uppercase TYPE; the lowercased origin should match without
      // a header rewrite, preserving the X-CUSTOM param.
      const out = patchVCard(card, {
        phones: [{ value: "+15551111111", type: "HOME" }],
      });
      expect(out).toContain("TEL;TYPE=HOME;X-CUSTOM=keep:+15551111111");
    });

    /**
     * @case ADR with TYPE but no components produces no phantom address
     * @preconditions Stray `ADR;TYPE=HOME:;;;;;;` line with no components
     * @expectedResult extractAddresses returns no entry for that record
     */
    test("ADR with TYPE but no components is not surfaced as a phantom address", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:P",
        "ADR;TYPE=HOME:;;;;;;",
        "UID:P2",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      expect(parsed.addresses).toBeUndefined();
    });

    /**
     * @case pairItems matches values across whitespace asymmetry
     * @preconditions Origin stores `+15551111111`; new item has surrounding whitespace
     * @expectedResult Patcher rewrites the origin (preserves params) instead of appending fresh
     */
    test("value-equality matching trims both sides", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:T",
        "TEL;TYPE=HOME;X-CUSTOM=keep:+15551111111",
        "UID:T2",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, {
        phones: [{ value: " +15551111111 ", type: "HOME" }],
      });
      const telLines = out
        .split(/\r?\n/)
        .filter((line) => line.startsWith("TEL"));
      expect(telLines).toHaveLength(1);
      expect(telLines[0]).toContain("X-CUSTOM=keep");
    });

    /**
     * @case Changing a TYPE on a TEL with multi-instance `TYPE=HOME;TYPE=PREF` preserves the PREF flag
     * @preconditions Origin has `TEL;TYPE=HOME;TYPE=PREF:+1`; user supplies `{ value: '+1', type: 'WORK' }`
     * @expectedResult The PREF flag survives the rewrite (only the primary TYPE segment is replaced)
     */
    test("replaceTypeInHeader preserves secondary TYPE=PREF flag on type change", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:P",
        "TEL;TYPE=HOME;TYPE=PREF:+15555551212",
        "UID:P3",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, {
        phones: [{ value: "+15555551212", type: "WORK" }],
      });
      // The primary TYPE flips to WORK; the PREF flag must survive.
      expect(out).toContain("TEL;TYPE=WORK;TYPE=PREF:+15555551212");
    });

    /**
     * @case mergeAddresses ref-fallback matches a fresh-constructed address by composite key
     * @preconditions Origin has a 7-component ADR with `Apt 4B` at index 1; user passes a fresh address object with the same street/city/postal (no origin ref)
     * @expectedResult The merger pairs the fresh item against the origin and preserves the extended-address bytes
     */
    test("mergeAddresses preserves extended-address bytes when matching by composite key", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:A",
        "ADR;TYPE=HOME:;Apt 4B;100 Main St;Springfield;IL;62704;USA",
        "UID:A1",
        "END:VCARD",
      ].join("\r\n");
      // Fresh address object (no WeakMap ref) — same street/city/postal as origin.
      const out = patchVCard(card, {
        addresses: [
          {
            type: "home",
            street: "100 Main St",
            city: "Springfield",
            region: "IL",
            postalCode: "62704",
            country: "USA",
          },
        ],
      });
      // Apt 4B must survive (preserved via origin pairing on the composite key).
      expect(out).toContain(";Apt 4B;");
      const adrLines = out
        .split(/\r?\n/)
        .filter((line) => line.startsWith("ADR"));
      expect(adrLines).toHaveLength(1);
    });

    /**
     * @case mergeIMPP no-scheme origin survives a no-op round-trip without synthesized scheme
     * @preconditions Origin has `IMPP:somehandle` (no colon, no scheme)
     * @expectedResult Round-trip emits the same bare-handle value; no `x-apple:` injection
     */
    test("mergeIMPP preserves bare-handle origin (no scheme injection)", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:I",
        "IMPP:somehandle",
        "UID:I4",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      const out = patchVCard(card, { instantMessages: parsed.instantMessages });
      expect(out).toContain("IMPP:somehandle");
      expect(out).not.toContain("x-apple:somehandle");
    });

    /**
     * @case mergePhoto preserves origin TYPE byte-for-byte on a no-op round-trip
     * @preconditions Origin has `PHOTO;ENCODING=b;TYPE=jpeg:<base64>` (lowercase `jpeg`)
     * @expectedResult Round-trip keeps `TYPE=jpeg` in original position; no re-canonicalization
     */
    test("mergePhoto does not re-canonicalize TYPE casing on no-op round-trip", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:P",
        "PHOTO;ENCODING=b;TYPE=jpeg:/9j/4AAQSkZJRgABAQ==",
        "UID:P4",
        "END:VCARD",
      ].join("\r\n");
      const parsed = parseVCard(card);
      const out = patchVCard(card, { photo: parsed.photo });
      // Origin's lowercase `jpeg` and original param order must survive.
      expect(out).toContain("PHOTO;ENCODING=b;TYPE=jpeg:");
    });

    /**
     * @case mergeCategories silently no-ops on empty / all-whitespace categories
     * @preconditions Card has `CATEGORIES:Friends`; user passes `categories: []`
     * @expectedResult Existing CATEGORIES line survives (no bare `CATEGORIES:` emitted that iCloud would reject)
     */
    test("mergeCategories rejects empty arrays as a no-op (parallels mergeTextSingleton)", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:C",
        "CATEGORIES:Friends",
        "UID:C1",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, { categories: [] });
      expect(out).toContain("CATEGORIES:Friends");
      expect(out).not.toMatch(/^CATEGORIES:\s*$/m);
    });

    /**
     * @case serializeContact with whitespace-only fullName falls through to the derivation chain
     * @preconditions `serializeContact({ uid: 'X', firstName: 'Jane', lastName: 'Doe', fullName: '   ' })`
     * @expectedResult FN is `Jane Doe` (derived), not the whitespace value or absent
     */
    test("deriveFullName falls through whitespace-only fullName to the firstName/lastName chain", () => {
      const out = serializeContact({
        uid: "X",
        firstName: "Jane",
        lastName: "Doe",
        fullName: "   ",
      });
      // Card must carry an FN line (vCard 3.0 mandates it).
      expect(out).toMatch(/^FN:Jane Doe$/m);
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
      const c = parseVCard(card);
      expect(c.organization).toBe("Acme; Inc.");
      expect(c.department).toBe("Sales");
      // Updating the department must preserve the company component verbatim.
      const out = patchVCard(card, { department: "Research" });
      const r = parseVCard(out);
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
      expect(parseVCard(out).note).toBe(long);
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
      const c = parseVCard(card);
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
      const r = parseVCard(out);
      expect(r.socialProfiles?.[0]?.service).toBe("we;ird");
      expect(r.socialProfiles?.[0]?.url).toBe("https://x");
    });

    /**
     * @case A category whose literal name contains a comma round-trips intact
     * @preconditions CATEGORIES carries an escaped comma inside one entry
     * @expectedResult parse splits only on unescaped commas; the name is preserved
     */
    test("category names containing commas survive the round-trip", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:C",
        "UID:C1",
        "CATEGORIES:Friends\\, Family,Work",
        "END:VCARD",
      ].join("\r\n");
      const c = parseVCard(card);
      expect(c.categories).toEqual(["Friends, Family", "Work"]);
      const out = patchVCard(card, { categories: c.categories });
      expect(parseVCard(out).categories).toEqual(["Friends, Family", "Work"]);
    });

    /**
     * @case PHOTO payloads with embedded whitespace fold without splitting
     * @preconditions PHOTO data carries CR/LF chunks (chunked base64)
     * @expectedResult Whitespace is stripped before folding so the value is one property
     */
    test("PHOTO data with embedded whitespace stays a single property", () => {
      const out = serializeContact({
        uid: "P1",
        fullName: "P",
        photo: { data: "AAAA\r\nBBBB\nCCCC", mediaType: "PNG" },
      });
      const r = parseVCard(out);
      expect(r.photo?.data).toBe("AAAABBBBCCCC");
      // No stray property line was introduced by the embedded newlines.
      const photoLines = out
        .split("\r\n")
        .filter((l) => l.startsWith("PHOTO") || l.startsWith(" "));
      // PHOTO must be one logical line (possibly folded), not split by CRs.
      expect(photoLines.length).toBeGreaterThan(0);
    });

    /**
     * @case Updating only a high-index N component does not crash
     * @preconditions N has fewer than 5 components; patch sets only `suffix`
     * @expectedResult patchVCard succeeds and the suffix lands in the right slot
     */
    test("updating only the suffix on a short N does not crash", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "N:Smith;John",
        "FN:John Smith",
        "UID:S1",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, { suffix: "Jr." });
      expect(out).toContain("N:Smith;John;;;Jr.");
    });

    /**
     * @case TYPE=HOME,PREF parses as a single label, not a "home,pref" string
     * @preconditions A TEL with comma-separated TYPE values
     * @expectedResult phone.type is the first non-pref value, lowercased
     */
    test("TYPE param with comma-separated values picks the first non-pref", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Q",
        "TEL;TYPE=HOME,PREF:+15555551212",
        "UID:Q1",
        "END:VCARD",
      ].join("\r\n");
      const c = parseVCard(card);
      expect(c.phones?.[0]?.type).toBe("home");
    });

    /**
     * @case A free-text value with CR/LF folds into a single \n escape on the wire
     * @preconditions A NOTE containing CRLF and bare CR
     * @expectedResult The serialized line carries `\n` escapes; no embedded CR remains
     */
    test("escapes carriage return and line feed in free-text values", () => {
      const out = serializeContact({
        uid: "N1",
        fullName: "N",
        note: "Line1\r\nLine2\rLine3\nLine4",
      });
      // No raw CR or LF survives inside a value: all line breaks are folded
      // into `\n` escapes (followed by the normal CRLF physical separators).
      const noteLines = out
        .split("\r\n")
        .filter(
          (l, i, all) =>
            l.startsWith("NOTE:") ||
            (i > 0 && all[i - 1]?.startsWith("NOTE:") && l.startsWith(" ")),
        );
      expect(noteLines.join("")).not.toMatch(/[^\\]\r/);
      const r = parseVCard(out);
      expect(r.note).toBe("Line1\nLine2\nLine3\nLine4");
    });

    /**
     * @case A leading blank line does not produce a phantom empty custom field
     * @preconditions A vCard whose first physical line is empty
     * @expectedResult The raw layer skips the blank; no record with key="" leaks
     */
    test("leading blank lines do not surface as phantom custom fields", () => {
      const card =
        "\r\n" +
        ["BEGIN:VCARD", "VERSION:3.0", "FN:B", "UID:B1", "END:VCARD"].join(
          "\r\n",
        );
      // vcf rejects vCards whose first line is not BEGIN:VCARD; the raw layer
      // is more lenient and must not surface a phantom record with an empty
      // rawName from the leading blank line.
      const custom = extractCustomFields(parseRecords(card));
      expect(custom.some((f) => f.key === "")).toBe(false);
    });

    /**
     * @case Patching a vCard collection refuses to flatten two cards into one
     * @preconditions Input contains two BEGIN/END:VCARD blocks
     * @expectedResult patchVCard throws (does not silently emit a broken card)
     */
    test("patchVCard refuses to patch a vCard collection", () => {
      const collection = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:A",
        "UID:a",
        "END:VCARD",
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:B",
        "UID:b",
        "END:VCARD",
      ].join("\r\n");
      expect(() => patchVCard(collection, { note: "x" })).toThrow(
        /vCard collection/i,
      );
    });

    /**
     * @case Unrelated grouped properties survive when a sibling is replaced
     * @preconditions item1 group holds both X-ABRELATEDNAMES and X-ABNICKNAME
     * @expectedResult Replacing relatedNames drops only the X-ABLabel sibling
     */
    test("unrelated grouped properties survive a relatedNames replace", () => {
      const card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:G",
        "UID:G1",
        "item1.X-ABRELATEDNAMES:Bob",
        "item1.X-ABLabel:_$!<Spouse>!$_",
        "item1.X-ABNICKNAME:Bobby",
        "END:VCARD",
      ].join("\r\n");
      const out = patchVCard(card, {
        relatedNames: [{ label: "child", name: "Alex" }],
      });
      expect(out).not.toContain("X-ABRELATEDNAMES:Bob");
      expect(out).not.toContain("item1.X-ABLabel:_$!<Spouse>!$_");
      // Unrelated property sharing the group must be preserved.
      expect(out).toContain("item1.X-ABNICKNAME:Bobby");
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
     * @case Save returns a UID that matches what is actually persisted
     * @preconditions Existing card has no UID; incoming contact also omits uid
     * @expectedResult The patched body carries a UID and result.uid equals it
     */
    test("save synthesizes a UID and writes it into the patched card", async () => {
      const cardWithoutUid = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:No UID",
        "END:VCARD",
      ].join("\r\n");
      const driver = fakeDriver([
        {
          url: "https://dav/card/no-uid.vcf",
          etag: '"1"',
          data: cardWithoutUid,
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
                url: "https://dav/card/no-uid.vcf",
                note: "added",
              }),
            )
            .to(carddav({ action: "save" }))
            .to(s),
        )
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      expect(driver.updated).toHaveLength(1);
      const sent = String(driver.updated[0]?.vCard.data);
      const result = s.received[0]?.body as CardDAVWriteResult;
      // The synthesized UID must have been written into the patched card so
      // result.uid identifies the actual server-side resource.
      expect(sent).toContain(`UID:${result.uid}`);
    });

    /**
     * @case Save against a record missing data still produces a valid vCard
     * @preconditions Driver returns a matching record with data === undefined
     * @expectedResult The PUT body has BEGIN:VCARD, VERSION, and END:VCARD
     */
    test("save with empty existing data falls through to a fresh serialize", async () => {
      const driver = fakeDriver([
        {
          url: "https://dav/card/empty.vcf",
          etag: '"1"',
          // Driver omitted the body; some servers do this on listing.
        },
      ]);
      CardDAVClientManager.createDriverClient = async () => driver;

      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(
              simple<Contact>({
                url: "https://dav/card/empty.vcf",
                uid: "FRESH-1",
                fullName: "Fresh",
              }),
            )
            .to(carddav({ action: "save" })),
        )
        .build();
      await t.test();

      expect(t.errors).toHaveLength(0);
      const sent = String(driver.updated[0]?.vCard.data);
      expect(sent).toContain("BEGIN:VCARD");
      expect(sent).toContain("VERSION:");
      expect(sent).toContain("UID:FRESH-1");
      expect(sent).toContain("FN:Fresh");
      expect(sent).toContain("END:VCARD");
    });

    /**
     * @case Writing a non-object body surfaces a clear configuration error
     * @preconditions Action is "create" and the upstream body is a string
     * @expectedResult The route raises RC5001 instead of persisting a bogus card
     */
    test("non-object body fails fast with RC5001", async () => {
      const driver = fakeDriver([]);
      CardDAVClientManager.createDriverClient = async () => driver;

      t = await testContext()
        .with(ACCOUNT_CONFIG)
        .routes(
          craft()
            .from(simple("not-a-contact"))
            .to(carddav({ action: "create" })),
        )
        .build();
      await t.test();

      expect(t.errors.some((e) => e.rc === "RC5001")).toBe(true);
      expect(driver.created).toHaveLength(0);
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
