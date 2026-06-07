/**
 * vCard <-> {@link Contact} codec.
 *
 * Two operations, no merge layer:
 *
 *  - {@link parseVCard} reads a card into a complete {@link Contact}. Every
 *    property round-trips: modeled ones via typed fields (with their wire
 *    parameters captured verbatim in `params`), everything else via `custom`.
 *    The goal is that a read never silently drops data.
 *  - {@link serializeContact} writes a {@link Contact} to a fresh card. It emits
 *    the whole object; it does not diff against an existing card. Dropping a
 *    field from the contact removes it from the output, exactly like writing a
 *    row to a database.
 *
 * Known, deliberate limitations (uncommon for Apple iCloud cards): structured
 * values with more components than the model names (`N` past 5, `ORG` past 2,
 * `ADR` past 7) keep only the named components on round-trip. A custom
 * `X-ABLabel` on a `URL`/`IMPP`/`X-SOCIALPROFILE` round-trips through `custom`
 * (the label text is preserved, but not re-attached to the typed item, since
 * those have no `label` field). `PHOTO` is emitted as base64 (`ENCODING=b`); a
 * second `PHOTO` or a `VALUE=uri` photo is not modeled. Built-in Apple label
 * re-wrapping (`_$!<Spouse>!$_`) is driven by a known-label table, so a wrapped
 * label outside that table round-trips unwrapped. Output line order, parameter-
 * name casing, and escaping are canonical, not byte-identical to the input.
 *
 * @experimental
 */

import {
  decodeLabel,
  emitProperty,
  encodeLabel,
  escapeText,
  firstParam,
  makeGroupAllocator,
  parseRecords,
  primaryType,
  splitOnUnescaped,
  type PropertySpec,
  type RawRecord,
  type VCardParam,
} from "./vcard-raw.ts";
import type {
  Contact,
  ContactAddress,
  ContactDate,
  ContactField,
  ContactInstantMessage,
  ContactRelatedName,
  ContactSocialProfile,
} from "./types.ts";

const CRLF = "\r\n";

/** Default vCard version written to iCloud and other CardDAV servers. */
export const DEFAULT_VCARD_VERSION = "3.0";

/**
 * Property names represented explicitly elsewhere (modeled fields) or emitted as
 * part of the envelope. Anything not in this set falls through to `custom`, so
 * standard-but-unmodeled properties (`PRODID`, `REV`, ...) round-trip too.
 */
const HANDLED_NAMES = new Set([
  "begin",
  "end",
  "version",
  "uid",
  "fn",
  "n",
  "nickname",
  "org",
  "title",
  "categories",
  "tel",
  "email",
  "adr",
  "url",
  "bday",
  "note",
  "photo",
  "impp",
  "x-socialprofile",
  "x-abdate",
  "x-abrelatednames",
  "x-ablabel",
]);

/**
 * Names of grouped "primary" properties whose `X-ABLabel` sibling is represented
 * as the item's `label` and so is consumed (excluded from `custom`). Only
 * properties whose typed model carries a `label` field belong here. `url`,
 * `impp`, and `x-socialprofile` deliberately do NOT: they have no `label` slot,
 * so their `X-ABLabel` must fall through to `custom` and round-trip verbatim
 * rather than being silently dropped.
 */
const GROUPED_PRIMARIES = new Set([
  "tel",
  "email",
  "adr",
  "x-abdate",
  "x-abrelatednames",
]);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse a vCard string into a {@link Contact}. The original text is kept on
 * `raw` for escape-hatch access.
 *
 * @throws If the input is not a single `BEGIN:VCARD ... END:VCARD` block.
 */
export function parseVCard(raw: string): Contact {
  const records = parseRecords(raw);

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
  if (beginCount > 1) {
    throw new SyntaxError(
      "vCard payload contains a vCard collection; parseVCard accepts a single card",
    );
  }

  // group -> decoded X-ABLabel, and which groups a modeled primary consumes.
  const labels = new Map<string, string>();
  const consumed = new Set<string>();
  for (const record of records) {
    if (record.name === "x-ablabel" && record.group) {
      labels.set(record.group, decodeLabel(record.value));
    }
    if (record.group && GROUPED_PRIMARIES.has(record.name)) {
      consumed.add(record.group);
    }
  }
  const labelFor = (record: RawRecord): string | undefined =>
    record.group ? labels.get(record.group) : undefined;

  const contact: Contact = { raw };

  const single = (name: string): string | undefined => {
    const record = records.find((r) => r.name === name && !r.group);
    return record && record.value.length > 0 ? record.value : undefined;
  };

  const uid = single("uid");
  if (uid) contact.uid = uid;
  const fullName = single("fn");
  if (fullName) contact.fullName = fullName;

  const nRecord = records.find((r) => r.name === "n" && !r.group);
  if (nRecord) {
    const parts = splitOnUnescaped(nRecord.rawValue, ";");
    assignIf(contact, "lastName", comp(parts, 0));
    assignIf(contact, "firstName", comp(parts, 1));
    assignIf(contact, "middleName", comp(parts, 2));
    assignIf(contact, "prefix", comp(parts, 3));
    assignIf(contact, "suffix", comp(parts, 4));
  }

  const nickname = single("nickname");
  if (nickname) contact.nickname = nickname;

  const orgRecord = records.find((r) => r.name === "org" && !r.group);
  if (orgRecord) {
    const parts = splitOnUnescaped(orgRecord.rawValue, ";");
    assignIf(contact, "organization", comp(parts, 0));
    assignIf(contact, "department", comp(parts, 1));
  }

  const title = single("title");
  if (title) contact.title = title;

  const categoriesRecord = records.find(
    (r) => r.name === "categories" && !r.group,
  );
  if (categoriesRecord) {
    const categories = splitOnUnescaped(categoriesRecord.rawValue, ",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (categories.length) contact.categories = categories;
  }

  const phones = records
    .filter((r) => r.name === "tel" && r.value.length > 0)
    .map((r) => ({ value: r.value, ...meta(r, labelFor(r)) }));
  if (phones.length) contact.phones = phones;

  const emails = records
    .filter((r) => r.name === "email" && r.value.length > 0)
    .map((r) => ({ value: r.value, ...meta(r, labelFor(r)) }));
  if (emails.length) contact.emails = emails;

  const addresses: ContactAddress[] = [];
  for (const record of records) {
    if (record.name !== "adr") continue;
    const parts = splitOnUnescaped(record.rawValue, ";");
    const address: ContactAddress = { ...meta(record, labelFor(record)) };
    assignIf(address, "poBox", comp(parts, 0));
    assignIf(address, "extended", comp(parts, 1));
    assignIf(address, "street", comp(parts, 2));
    assignIf(address, "city", comp(parts, 3));
    assignIf(address, "region", comp(parts, 4));
    assignIf(address, "postalCode", comp(parts, 5));
    assignIf(address, "country", comp(parts, 6));
    const hasContent = parts.some((p, i) => i < 7 && p.length > 0);
    if (hasContent) addresses.push(address);
  }
  if (addresses.length) contact.addresses = addresses;

  const urls = records
    .filter((r) => r.name === "url" && r.value.length > 0)
    .map((r) => r.value);
  if (urls.length) contact.urls = urls;

  const birthday = single("bday");
  if (birthday) contact.birthday = birthday;
  const note = single("note");
  if (note) contact.note = note;

  const photoRecord = records.find((r) => r.name === "photo");
  if (photoRecord && photoRecord.value.length > 0) {
    contact.photo = { data: photoRecord.value };
    const type = firstParam(photoRecord, "type");
    if (type) contact.photo.mediaType = type.toUpperCase();
  }

  const instantMessages: ContactInstantMessage[] = [];
  for (const record of records) {
    if (record.name !== "impp" || record.value.length === 0) continue;
    const { scheme, handle } = parseImppValue(record.value);
    const im: ContactInstantMessage = { handle };
    const service = firstParam(record, "x-service-type");
    if (service) im.service = service;
    if (scheme) im.scheme = scheme;
    if (record.params.length) im.params = record.params;
    instantMessages.push(im);
  }
  if (instantMessages.length) contact.instantMessages = instantMessages;

  const socialProfiles: ContactSocialProfile[] = [];
  for (const record of records) {
    if (record.name !== "x-socialprofile" || record.value.length === 0) {
      continue;
    }
    const profile: ContactSocialProfile = { url: record.value };
    const service = primaryType(record);
    if (service) profile.service = service;
    if (record.params.length) profile.params = record.params;
    socialProfiles.push(profile);
  }
  if (socialProfiles.length) contact.socialProfiles = socialProfiles;

  const relatedNames: ContactRelatedName[] = [];
  for (const record of records) {
    if (record.name !== "x-abrelatednames") continue;
    const related: ContactRelatedName = {
      label: labelFor(record) ?? "other",
      name: record.value,
    };
    if (record.params.length) related.params = record.params;
    relatedNames.push(related);
  }
  if (relatedNames.length) contact.relatedNames = relatedNames;

  const dates: ContactDate[] = [];
  for (const record of records) {
    if (record.name !== "x-abdate") continue;
    const date: ContactDate = {
      label: labelFor(record) ?? "other",
      date: record.value,
    };
    if (record.params.length) date.params = record.params;
    dates.push(date);
  }
  if (dates.length) contact.dates = dates;

  const custom: ContactField[] = [];
  for (const record of records) {
    if (!record.rawName) continue;
    if (record.name === "x-ablabel") {
      // Keep only orphan labels (no modeled primary in their group); consumed
      // ones are represented as an item's `label`.
      if (record.group && consumed.has(record.group)) continue;
    } else if (HANDLED_NAMES.has(record.name)) {
      continue;
    }
    const field: ContactField = { key: record.rawName, value: record.value };
    const type = primaryType(record);
    if (type) field.type = type;
    if (record.rawGroup) field.group = record.rawGroup;
    if (record.params.length) field.params = record.params;
    custom.push(field);
  }
  if (custom.length) contact.custom = custom;

  return contact;
}

/** Item-level metadata shared by phones, emails, and addresses. */
function meta(
  record: RawRecord,
  label: string | undefined,
): { type?: string; label?: string; params?: VCardParam[] } {
  const out: { type?: string; label?: string; params?: VCardParam[] } = {};
  const type = primaryType(record);
  if (type) out.type = type;
  if (label !== undefined) out.label = label;
  if (record.params.length) out.params = record.params;
  return out;
}

function comp(parts: string[], index: number): string | undefined {
  const value = parts[index];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function assignIf<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function parseImppValue(value: string): { scheme?: string; handle: string } {
  const colon = value.indexOf(":");
  if (colon < 0) return { handle: value };
  return { scheme: value.slice(0, colon), handle: value.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Derive a display name (vCard `FN` is mandatory) from a contact's fields. */
function deriveFullName(contact: Contact): string {
  if (contact.fullName && contact.fullName.trim().length > 0) {
    return contact.fullName;
  }
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
 * Build the wire parameters for an item: start from `params` (verbatim), then
 * apply the ergonomic `type` over the primary `TYPE` so editing `type` works
 * without the caller having to touch `params`.
 */
function itemParams(item: {
  type?: string;
  params?: VCardParam[];
}): VCardParam[] {
  const params = item.params ? item.params.map((p) => ({ ...p })) : [];
  if (item.type !== undefined) applyType(params, item.type);
  return params;
}

/**
 * Replace the primary (first non-`pref`) TYPE value, or append one. When the
 * primary already equals `type` case-insensitively it is left untouched, so a
 * no-op round-trip (where `type` was derived from these very params) preserves
 * the original casing instead of canonicalizing it.
 */
function applyType(params: VCardParam[], type: string): void {
  const primary = params.find(
    (p) => p.name === "type" && p.value.toLowerCase() !== "pref",
  );
  if (primary) {
    if (primary.value.toLowerCase() !== type.toLowerCase())
      primary.value = type;
  } else {
    params.push({ name: "type", value: type });
  }
}

/** Replace the first occurrence of `name` (case-insensitive match), or append. */
function setParam(params: VCardParam[], name: string, value: string): void {
  const existing = params.find((p) => p.name === name);
  if (existing) existing.value = value;
  else params.push({ name, value });
}

/**
 * Serialize a contact into a fresh vCard string, guaranteeing the mandatory
 * `FN`. This replaces the card; it does not merge with any existing one.
 */
export function serializeContact(
  contact: Contact,
  version: string = DEFAULT_VCARD_VERSION,
): string {
  const lines: string[] = ["BEGIN:VCARD", `VERSION:${version}`];
  const allocGroup = makeGroupAllocator(
    (contact.custom ?? []).map((c) => c.group),
  );

  const emit = (
    name: string,
    value: string,
    params?: VCardParam[],
    group?: string,
  ): void => {
    const spec: PropertySpec = { name, value };
    if (params && params.length) spec.params = params;
    if (group) spec.group = group;
    lines.push(emitProperty(spec));
  };

  /** Emit an item, grouping it with an X-ABLabel sibling when it has a label. */
  const emitItem = (
    name: string,
    value: string,
    item: { type?: string; label?: string; params?: VCardParam[] },
  ): void => {
    const params = itemParams(item);
    if (item.label !== undefined) {
      const group = allocGroup();
      emit(name, value, params, group);
      emit("X-ABLabel", escapeText(encodeLabel(item.label)), undefined, group);
    } else {
      emit(name, value, params);
    }
  };

  if (contact.uid) emit("UID", escapeText(contact.uid));
  emit("FN", escapeText(deriveFullName(contact)));

  if (hasNameParts(contact)) {
    const value = [
      contact.lastName,
      contact.firstName,
      contact.middleName,
      contact.prefix,
      contact.suffix,
    ]
      .map((c) => escapeText(c ?? ""))
      .join(";");
    emit("N", value);
  }

  if (contact.nickname) emit("NICKNAME", escapeText(contact.nickname));

  if (contact.organization !== undefined || contact.department !== undefined) {
    const value = [contact.organization, contact.department]
      .map((c) => escapeText(c ?? ""))
      .join(";");
    emit("ORG", value);
  }

  if (contact.title) emit("TITLE", escapeText(contact.title));

  if (contact.categories?.length) {
    emit("CATEGORIES", contact.categories.map(escapeText).join(","));
  }

  if (contact.birthday) emit("BDAY", escapeText(contact.birthday));
  if (contact.note) emit("NOTE", escapeText(contact.note));

  if (contact.photo) {
    emit("PHOTO", contact.photo.data.replace(/\s+/g, ""), [
      { name: "ENCODING", value: "b" },
      {
        name: "TYPE",
        value: (contact.photo.mediaType ?? "JPEG").toUpperCase(),
      },
    ]);
  }

  for (const phone of contact.phones ?? []) {
    emitItem("TEL", escapeText(phone.value), phone);
  }
  for (const email of contact.emails ?? []) {
    emitItem("EMAIL", escapeText(email.value), email);
  }
  for (const address of contact.addresses ?? []) {
    const value = [
      address.poBox,
      address.extended,
      address.street,
      address.city,
      address.region,
      address.postalCode,
      address.country,
    ]
      .map((c) => escapeText(c ?? ""))
      .join(";");
    emitItem("ADR", value, address);
  }
  for (const url of contact.urls ?? []) {
    emit("URL", escapeText(url));
  }

  for (const im of contact.instantMessages ?? []) {
    const params = im.params ? im.params.map((p) => ({ ...p })) : [];
    // The ergonomic `service` field is authoritative over a stored
    // X-SERVICE-TYPE, so editing it takes effect (a no-op round-trip is
    // unchanged because the stored value already matches).
    if (im.service !== undefined)
      setParam(params, "x-service-type", im.service);
    const scheme = im.scheme ?? (im.service?.toLowerCase() || "x-apple");
    emit("IMPP", `${scheme}:${escapeText(im.handle)}`, params);
  }

  for (const profile of contact.socialProfiles ?? []) {
    // Apple stores the social service in a `type` param; reuse the same
    // type-over-params reconciliation as phones/emails so it survives a PREF
    // flag and an edited `service` both apply correctly.
    const params = itemParams({
      ...(profile.service !== undefined ? { type: profile.service } : {}),
      ...(profile.params ? { params: profile.params } : {}),
    });
    emit("X-SOCIALPROFILE", escapeText(profile.url), params);
  }

  for (const related of contact.relatedNames ?? []) {
    const group = allocGroup();
    emit(
      "X-ABRELATEDNAMES",
      escapeText(related.name),
      related.params?.map((p) => ({ ...p })),
      group,
    );
    emit("X-ABLabel", escapeText(encodeLabel(related.label)), undefined, group);
  }

  for (const date of contact.dates ?? []) {
    const group = allocGroup();
    emit(
      "X-ABDATE",
      escapeText(date.date),
      date.params?.map((p) => ({ ...p })),
      group,
    );
    emit("X-ABLabel", escapeText(encodeLabel(date.label)), undefined, group);
  }

  for (const field of contact.custom ?? []) {
    if (!field.key) continue;
    emit(field.key, escapeText(field.value), itemParams(field), field.group);
  }

  lines.push("END:VCARD");
  return lines.join(CRLF);
}

function hasNameParts(contact: Contact): boolean {
  return (
    contact.firstName !== undefined ||
    contact.lastName !== undefined ||
    contact.middleName !== undefined ||
    contact.prefix !== undefined ||
    contact.suffix !== undefined
  );
}
