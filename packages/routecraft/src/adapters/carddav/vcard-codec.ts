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

import type { VCardConstructor } from "vcf";
import { loadOptionalPeer } from "../shared/optional-peer.ts";
import {
  extractAddresses,
  extractCategories,
  extractCustomFields,
  extractDates,
  extractEmails,
  extractInstantMessages,
  extractName,
  extractOrg,
  extractPhones,
  extractPhoto,
  extractRelatedNames,
  extractSocialProfiles,
  extractTextValue,
  extractUrls,
  groupLabels,
  parseRecords,
  patchRawVCard,
} from "./vcard-raw.ts";
import type { Contact } from "./types.ts";

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

/**
 * Parse a vCard string into a normalized {@link Contact}. The original text is
 * preserved on `raw` so updates can keep fields the model does not cover.
 *
 * Each array item in the returned contact carries a hidden `RECORD_ORIGIN`
 * back-ref to its source raw record. The patcher uses these refs to do
 * per-record diff/merge on update, so any parameter, group prefix, or labeled
 * sibling the structured model does not surface is preserved on round-trip.
 *
 * `vcf` is invoked solely to validate that the input is a parseable vCard
 * (it throws on malformed input); every field is then read from the raw
 * layer so RFC 6350 text escapes decode correctly and property casing is
 * preserved.
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

  // Parse records ONCE and pass through every extractor. Each extractor
  // returns items carrying a hidden `RECORD_ORIGIN` back-ref to its source
  // record; the patcher uses those refs to rewrite only the bytes the user
  // changed, preserving every param/group/sibling the model does not surface.
  const records = parseRecords(raw);
  const labels = groupLabels(records);

  const uid = extractTextValue(records, "uid");
  if (uid) contact.uid = uid;
  const fullName = extractTextValue(records, "fn");
  if (fullName) contact.fullName = fullName;
  Object.assign(contact, extractName(records));
  const nickname = extractTextValue(records, "nickname");
  if (nickname) contact.nickname = nickname;
  Object.assign(contact, extractOrg(records));
  const title = extractTextValue(records, "title");
  if (title) contact.title = title;
  const categories = extractCategories(records);
  if (categories.length) contact.categories = categories;
  const phones = extractPhones(records);
  if (phones.length) contact.phones = phones;
  const emails = extractEmails(records);
  if (emails.length) contact.emails = emails;
  const addresses = extractAddresses(records);
  if (addresses.length) contact.addresses = addresses;
  const urls = extractUrls(records);
  if (urls.length) contact.urls = urls;
  const birthday = extractTextValue(records, "bday");
  if (birthday) contact.birthday = birthday;
  const note = extractTextValue(records, "note");
  if (note) contact.note = note;
  const photo = extractPhoto(records);
  if (photo) contact.photo = photo;
  const instantMessages = extractInstantMessages(records);
  if (instantMessages.length) contact.instantMessages = instantMessages;
  const socialProfiles = extractSocialProfiles(records);
  if (socialProfiles.length) contact.socialProfiles = socialProfiles;
  const relatedNames = extractRelatedNames(records, labels);
  if (relatedNames.length) contact.relatedNames = relatedNames;
  const dates = extractDates(records, labels);
  if (dates.length) contact.dates = dates;
  const custom = extractCustomFields(records);
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
