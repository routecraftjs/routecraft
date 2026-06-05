/**
 * vCard <-> {@link Contact} codec.
 *
 * Parse, serialize, and patch run through the raw layer in `vcard-raw.ts`. No
 * external peer is required: the audit-driven refactor moved every field read
 * onto the raw extractors (so RFC 6350 text escapes decode correctly and
 * iCloud property casing is preserved), leaving the `vcf` peer with nothing
 * to do.
 *
 * @experimental
 */

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

/**
 * Parse a vCard string into a normalized {@link Contact}. The original text is
 * preserved on `raw` so updates can keep fields the model does not cover.
 *
 * Each array item in the returned contact carries a hidden back-ref to its
 * source raw record (in a `WeakMap`). The patcher uses these refs to do
 * per-record diff/merge on update, so any parameter, group prefix, or labeled
 * sibling the structured model does not surface is preserved on round-trip.
 *
 * @throws If the input does not contain a parseable `BEGIN:VCARD ... END:VCARD`.
 */
export function parseVCard(raw: string): Contact {
  const records = parseRecords(raw);
  // Validate the envelope. The raw layer is otherwise tolerant of partial
  // input; tightening the contract here gives callers a clear `SyntaxError`
  // for obviously-broken payloads rather than silently empty contacts.
  let beginCount = 0;
  let hasEnd = false;
  for (const record of records) {
    if (record.name === "begin" && record.value.toUpperCase() === "VCARD") {
      beginCount++;
    }
    if (record.name === "end" && record.value.toUpperCase() === "VCARD") {
      hasEnd = true;
    }
  }
  if (beginCount === 0 || !hasEnd) {
    throw new SyntaxError(
      "vCard payload did not contain a BEGIN:VCARD/END:VCARD block",
    );
  }
  // A vCard collection (multiple BEGIN:VCARD blocks) would silently flatten
  // into one Contact, losing the second card's data. Reject explicitly so the
  // caller can iterate the payload instead.
  if (beginCount > 1) {
    throw new SyntaxError(
      "vCard payload contains a vCard collection; parseVCard accepts a single card",
    );
  }

  const contact: Contact = { raw };
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
 * place. Create is a patch over an empty card.
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
