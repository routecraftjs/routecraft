/**
 * vCard <-> {@link Contact} codec, isolated behind a small surface so the
 * underlying library (`vcf`) can be swapped without touching the adapter.
 *
 * `vcf` is used because it round-trips vCard 3.0 (what iCloud emits) as well as
 * 4.0. The parse/serialize functions are pure and take the `vCard` constructor,
 * so they are testable without the optional-peer loader or any network.
 *
 * @experimental
 */

import type { VCardConstructor, VCardInstance, VCardProperty } from "vcf";
import { loadOptionalPeer } from "../shared/optional-peer.ts";
import {
  extractAddresses,
  extractCustomFields,
  extractDates,
  extractInstantMessages,
  extractName,
  extractOrg,
  extractRelatedNames,
  extractSocialProfiles,
  patchRawVCard,
} from "./vcard-raw.ts";
import type {
  Contact,
  ContactEmail,
  ContactPhone,
  ContactPhoto,
} from "./types.ts";

/** Default vCard version written to iCloud and other CardDAV servers. */
export const DEFAULT_VCARD_VERSION = "3.0";

let vcfPromise: Promise<VCardConstructor> | null = null;

/**
 * Lazily load the `vcf` constructor as an optional peer. Cached after the first
 * call. Emits `RC5017` with an install hint when the package is missing.
 */
export function loadVCardConstructor(): Promise<VCardConstructor> {
  vcfPromise ??= loadOptionalPeer(() => import("vcf"), {
    adapterName: "carddav",
    packageName: "vcf",
  }).then((m) => m.default);
  return vcfPromise;
}

/** Reset the cached `vcf` loader. Test-only seam. */
export function resetVCardConstructorCache(): void {
  vcfPromise = null;
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

function allProps(card: VCardInstance, key: string): VCardProperty[] {
  const value = card.get(key);
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstProp(
  card: VCardInstance,
  key: string,
): VCardProperty | undefined {
  return allProps(card, key)[0];
}

function firstValue(card: VCardInstance, key: string): string | undefined {
  const prop = firstProp(card, key);
  if (!prop) return undefined;
  const value = String(prop.valueOf()).trim();
  return value.length > 0 ? value : undefined;
}

/** Normalize a `TYPE` parameter to a single lowercase label. */
function propType(prop: VCardProperty): string | undefined {
  const type = prop.type;
  if (type == null) return undefined;
  const label = Array.isArray(type) ? type.join(",") : type;
  const normalized = String(label).trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Parse a vCard string into a normalized {@link Contact}. The original text is
 * preserved on `raw` so updates can keep fields the model does not cover.
 *
 * @throws If the input is not a parseable vCard.
 */
export function parseVCard(Ctor: VCardConstructor, raw: string): Contact {
  const cards = Ctor.parse(raw);
  const card = cards[0];
  if (!card) {
    throw new SyntaxError("vCard payload contained no card");
  }

  const contact: Contact = { raw };

  const uid = firstValue(card, "uid");
  if (uid) contact.uid = uid;

  const fullName = firstValue(card, "fn");
  if (fullName) contact.fullName = fullName;

  // Structured properties (N, ORG, ADR) are read from the raw layer, which
  // splits on unescaped separators so an escaped `\;` inside a component is
  // not mistaken for a component boundary.
  Object.assign(contact, extractName(raw));

  const nickname = firstValue(card, "nickname");
  if (nickname) contact.nickname = nickname;

  Object.assign(contact, extractOrg(raw));

  const title = firstValue(card, "title");
  if (title) contact.title = title;

  const categories = firstValue(card, "categories");
  if (categories) {
    const list = categories
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (list.length) contact.categories = list;
  }

  const phones = allProps(card, "tel")
    .map((p): ContactPhone | null => {
      const value = String(p.valueOf()).trim();
      if (!value) return null;
      const type = propType(p);
      return type ? { value, type } : { value };
    })
    .filter((p): p is ContactPhone => p !== null);
  if (phones.length) contact.phones = phones;

  const emails = allProps(card, "email")
    .map((p): ContactEmail | null => {
      const value = String(p.valueOf()).trim();
      if (!value) return null;
      const type = propType(p);
      return type ? { value, type } : { value };
    })
    .filter((e): e is ContactEmail => e !== null);
  if (emails.length) contact.emails = emails;

  const addresses = extractAddresses(raw);
  if (addresses.length) contact.addresses = addresses;

  const urls = allProps(card, "url")
    .map((p) => String(p.valueOf()).trim())
    .filter((u) => u.length > 0);
  if (urls.length) contact.urls = urls;

  const birthday = firstValue(card, "bday");
  if (birthday) contact.birthday = birthday;

  const note = firstValue(card, "note");
  if (note) contact.note = note;

  const photoProp = firstProp(card, "photo");
  if (photoProp) {
    const data = String(photoProp.valueOf()).trim();
    if (data) {
      const photo: ContactPhoto = { data };
      const type = propType(photoProp);
      if (type) photo.mediaType = type.toUpperCase();
      contact.photo = photo;
    }
  }

  // iCloud-specific and unmodeled properties are read straight from the raw
  // text (faithful names/params/groups), since `vcf` normalizes casing.
  const instantMessages = extractInstantMessages(raw);
  if (instantMessages.length) contact.instantMessages = instantMessages;
  const socialProfiles = extractSocialProfiles(raw);
  if (socialProfiles.length) contact.socialProfiles = socialProfiles;
  const relatedNames = extractRelatedNames(raw);
  if (relatedNames.length) contact.relatedNames = relatedNames;
  const dates = extractDates(raw);
  if (dates.length) contact.dates = dates;
  const custom = extractCustomFields(raw);
  if (custom.length) contact.custom = custom;

  return contact;
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

/** Derive a display name (vCard `FN` is mandatory) from a contact's fields. */
function deriveFullName(contact: Contact): string {
  if (contact.fullName) return contact.fullName;
  const parts = [contact.firstName, contact.middleName, contact.lastName]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ")
    .trim();
  return (
    parts ||
    contact.organization ||
    contact.emails?.[0]?.value ||
    contact.uid ||
    "Unknown"
  );
}

/**
 * Serialize a contact into a fresh vCard string, guaranteeing the mandatory
 * `FN`. Writing goes entirely through the raw emitter (the single writer), so
 * escaping, folding, grouping, and property-name casing are handled in one
 * place; `vcf` is used only for parsing. Create is a patch over an empty card.
 */
export function serializeContact(
  contact: Contact,
  version: string = DEFAULT_VCARD_VERSION,
): string {
  const skeleton = `BEGIN:VCARD\r\nVERSION:${version}\r\nEND:VCARD`;
  return patchRawVCard(skeleton, {
    ...contact,
    fullName: deriveFullName(contact),
  });
}

/**
 * Apply the contact's provided fields onto an existing vCard string, rewriting
 * only the properties it changes and copying every other line through verbatim,
 * so unmodeled properties (custom `X-` fields, grouped labels) are never
 * corrupted. Use for partial updates.
 */
export function patchVCard(existingRaw: string, contact: Contact): string {
  return patchRawVCard(existingRaw, contact);
}
