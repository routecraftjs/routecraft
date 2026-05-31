/**
 * Raw vCard line model and surgical patcher.
 *
 * The update path must never corrupt or drop properties the {@link Contact}
 * model does not manage (custom `X-` fields, grouped `item N.X-ABLabel` labels,
 * IMPP, social profiles, etc.). Re-serializing through `vcf` mangles mixed-case
 * property names and upper-cases values, so updates instead operate on the raw
 * text: only the lines for fields the contact explicitly changes are rewritten,
 * and every other physical line is copied through byte-for-byte.
 *
 * @experimental
 */

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

/**
 * Property names the structured {@link Contact} model already owns, so they are
 * never surfaced as (or duplicated by) `custom` fields.
 */
const MODELED_NAMES = new Set([
  "begin",
  "end",
  "version",
  "prodid",
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
  // Grouped, label-paired properties.
  "x-abdate",
  "x-ablabel",
  "x-abrelatednames",
]);

interface RawRecord {
  /** Lowercased property name without group (e.g. `tel`, `x-socialprofile`). */
  name: string;
  /** Lowercased group prefix (e.g. `item1`), or null. */
  group: string | null;
  /** Original property name as written (e.g. `X-SOCIALPROFILE`). */
  rawName: string;
  /** Original group as written (e.g. `item1`), or null. */
  rawGroup: string | null;
  /** `TYPE` parameter value (lowercased), if present. */
  type: string | null;
  /** All parameters, keyed by lowercased name (raw values). */
  params: Record<string, string>;
  /** Unescaped value (after the first colon, with line folding undone). */
  value: string;
  /** Raw (still-escaped) value, for component-accurate structured splitting. */
  rawValue: string;
  /** Original physical lines, kept verbatim for re-emit. */
  physical: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split raw vCard text into records, grouping folded continuation lines. */
function parseRecords(raw: string): RawRecord[] {
  const physical = raw.split(/\r\n|\r|\n/);
  while (physical.length > 0 && physical[physical.length - 1] === "") {
    physical.pop();
  }

  const records: RawRecord[] = [];
  let current: string[] | null = null;

  const flush = (): void => {
    if (current) records.push(toRecord(current));
    current = null;
  };

  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && current) {
      current.push(line);
    } else {
      flush();
      current = [line];
    }
  }
  flush();
  return records;
}

/** Index of the first `ch` in `s` that is not inside a double-quoted span. */
function indexOfUnquoted(s: string, ch: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ch && !inQuote) return i;
  }
  return -1;
}

/** Split `s` on `;` that are not inside a double-quoted param value. */
function splitUnquoted(s: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  for (const c of s) {
    if (c === '"') {
      inQuote = !inQuote;
      current += c;
    } else if (c === ";" && !inQuote) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/** Strip surrounding double quotes from a parameter value (RFC 6350 §3.3). */
function dequoteParam(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function toRecord(lines: string[]): RawRecord {
  // Undo folding to get the logical line for header/value parsing.
  const logical = lines
    .map((line, index) => (index === 0 ? line : line.slice(1)))
    .join("");

  // The header/value boundary is the first colon that is not inside a quoted
  // parameter value (e.g. `KEY;TYPE="a:b":value`).
  const colon = indexOfUnquoted(logical, ":");
  const header = colon >= 0 ? logical.slice(0, colon) : logical;
  const value = colon >= 0 ? logical.slice(colon + 1) : "";

  const segments = splitUnquoted(header);
  const nameSegment = segments[0] ?? "";
  const dot = nameSegment.indexOf(".");
  const rawGroup = dot >= 0 ? nameSegment.slice(0, dot) : null;
  const rawName = dot >= 0 ? nameSegment.slice(dot + 1) : nameSegment;

  let type: string | null = null;
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    const key = (eq >= 0 ? segment.slice(0, eq) : segment).toLowerCase();
    const paramValue = dequoteParam(eq >= 0 ? segment.slice(eq + 1) : segment);
    // `TYPE` may repeat (e.g. TYPE=HOME;TYPE=pref); keep the first non-pref one.
    if (
      key === "type" &&
      paramValue &&
      type === null &&
      paramValue.toLowerCase() !== "pref"
    ) {
      type = paramValue.toLowerCase();
    }
    if (params[key] === undefined) params[key] = paramValue;
  }

  return {
    name: rawName.toLowerCase(),
    group: rawGroup ? rawGroup.toLowerCase() : null,
    rawName,
    rawGroup,
    type,
    params,
    value: unescapeText(value),
    rawValue: value,
    physical: lines,
  };
}

/**
 * Split a structured value (`N`, `ADR`, `ORG`) into components on unescaped
 * `;`, then unescape each component. Walking with explicit escape tracking
 * handles `\;` (escaped separator) and `\\;` (escaped backslash + separator)
 * correctly, which a naive `split(";")` over the unescaped value does not.
 */
function splitComponents(rawValue: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i];
    if (ch === "\\" && i + 1 < rawValue.length) {
      current += ch + rawValue[i + 1];
      i++;
    } else if (ch === ";") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(unescapeText);
}

// ---------------------------------------------------------------------------
// Reading: custom fields and labeled dates
// ---------------------------------------------------------------------------

/** Decode Apple's `_$!<Label>!$_` wrapper to a plain label. */
function decodeLabel(label: string): string {
  const match = /^_\$!<(.+)>!\$_$/.exec(label);
  return match ? (match[1] as string) : label;
}

/** Extract labeled dates (`X-ABDATE` grouped with `X-ABLabel`). */
export function extractDates(raw: string): ContactDate[] {
  const records = parseRecords(raw);
  const labels = groupLabels(records);
  const dates: ContactDate[] = [];
  for (const record of records) {
    if (record.name !== "x-abdate") continue;
    const label = record.group ? labels.get(record.group) : undefined;
    dates.push({ label: label ?? "other", date: record.value });
  }
  return dates;
}

/** Build a group -> decoded label map from `X-ABLabel` records. */
function groupLabels(records: RawRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const record of records) {
    if (record.name === "x-ablabel" && record.group) {
      labels.set(record.group, decodeLabel(record.value));
    }
  }
  return labels;
}

/** Extract instant-messaging handles (`IMPP`, iCloud `X-SERVICE-TYPE`). */
export function extractInstantMessages(raw: string): ContactInstantMessage[] {
  const out: ContactInstantMessage[] = [];
  for (const record of parseRecords(raw)) {
    if (record.name !== "impp") continue;
    const colon = record.value.indexOf(":");
    const handle = colon >= 0 ? record.value.slice(colon + 1) : record.value;
    const service = record.params["x-service-type"];
    const im: ContactInstantMessage = { handle };
    if (service) im.service = service;
    out.push(im);
  }
  return out;
}

/** Extract social-media profiles (iCloud `X-SOCIALPROFILE`). */
export function extractSocialProfiles(raw: string): ContactSocialProfile[] {
  const out: ContactSocialProfile[] = [];
  for (const record of parseRecords(raw)) {
    if (record.name !== "x-socialprofile") continue;
    const profile: ContactSocialProfile = { url: record.value };
    if (record.type) profile.service = record.type;
    out.push(profile);
  }
  return out;
}

/** Extract related people (`X-ABRELATEDNAMES` grouped with `X-ABLabel`). */
export function extractRelatedNames(raw: string): ContactRelatedName[] {
  const records = parseRecords(raw);
  const labels = groupLabels(records);
  const out: ContactRelatedName[] = [];
  for (const record of records) {
    if (record.name !== "x-abrelatednames") continue;
    const label = record.group ? labels.get(record.group) : undefined;
    out.push({ label: label ?? "other", name: record.value });
  }
  return out;
}

function component(parts: string[], index: number): string | undefined {
  const value = parts[index]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Read the structured `N` name parts, splitting on unescaped separators. */
export function extractName(
  raw: string,
): Pick<
  Contact,
  "firstName" | "lastName" | "middleName" | "prefix" | "suffix"
> {
  const record = parseRecords(raw).find((r) => r.name === "n" && !r.group);
  if (!record) return {};
  const parts = splitComponents(record.rawValue);
  const out: Pick<
    Contact,
    "firstName" | "lastName" | "middleName" | "prefix" | "suffix"
  > = {};
  const last = component(parts, 0);
  const first = component(parts, 1);
  const middle = component(parts, 2);
  const prefix = component(parts, 3);
  const suffix = component(parts, 4);
  if (last) out.lastName = last;
  if (first) out.firstName = first;
  if (middle) out.middleName = middle;
  if (prefix) out.prefix = prefix;
  if (suffix) out.suffix = suffix;
  return out;
}

/** Read `ORG` company and department, splitting on unescaped separators. */
export function extractOrg(
  raw: string,
): Pick<Contact, "organization" | "department"> {
  const record = parseRecords(raw).find((r) => r.name === "org" && !r.group);
  if (!record) return {};
  const parts = splitComponents(record.rawValue);
  const out: Pick<Contact, "organization" | "department"> = {};
  const organization = component(parts, 0);
  const department = component(parts, 1);
  if (organization) out.organization = organization;
  if (department) out.department = department;
  return out;
}

/** Read `ADR` records, splitting components on unescaped separators. */
export function extractAddresses(raw: string): ContactAddress[] {
  const out: ContactAddress[] = [];
  for (const record of parseRecords(raw)) {
    if (record.name !== "adr") continue;
    const parts = splitComponents(record.rawValue);
    const address: ContactAddress = {};
    if (record.type) address.type = record.type;
    const poBox = component(parts, 0);
    const street = component(parts, 2);
    const city = component(parts, 3);
    const region = component(parts, 4);
    const postalCode = component(parts, 5);
    const country = component(parts, 6);
    if (poBox) address.poBox = poBox;
    if (street) address.street = street;
    if (city) address.city = city;
    if (region) address.region = region;
    if (postalCode) address.postalCode = postalCode;
    if (country) address.country = country;
    if (Object.keys(address).length > 0) out.push(address);
  }
  return out;
}

/**
 * Extract properties outside the managed model (e.g. arbitrary `X-` fields) so
 * callers can read them. Managed and grouped-label properties are excluded.
 */
export function extractCustomFields(raw: string): ContactField[] {
  const records = parseRecords(raw);
  const fields: ContactField[] = [];
  for (const record of records) {
    if (MODELED_NAMES.has(record.name)) continue;
    const field: ContactField = { key: record.rawName, value: record.value };
    if (record.type) field.type = record.type;
    if (record.rawGroup) field.group = record.rawGroup;
    fields.push(field);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Emitting new lines
// ---------------------------------------------------------------------------

/**
 * Escape a value per RFC 6350 (backslash, comma, semicolon, newline). Used for
 * both free-text values and individual components of structured values (`N`,
 * `ADR`), where the literal `;` separators are added afterward by the caller.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_m, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

/**
 * Fold a logical line to <=75 octets per physical line using CRLF + single
 * space continuations (RFC 6350 §3.2). Counts UTF-8 byte length and never
 * splits inside a code point, so multibyte values (accents, CJK, emoji) fold
 * safely. The leading space of a continuation counts toward its 75 octets.
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let isContinuation = false;
  // Continuation lines spend one octet on their leading space.
  const maxContentBytes = (): number => (isContinuation ? 74 : 75);
  for (const ch of line) {
    const charBytes = Buffer.byteLength(ch, "utf8");
    if (current !== "" && currentBytes + charBytes > maxContentBytes()) {
      out.push(isContinuation ? ` ${current}` : current);
      isContinuation = true;
      current = ch;
      currentBytes = charBytes;
    } else {
      current += ch;
      currentBytes += charBytes;
    }
  }
  if (current !== "") out.push(isContinuation ? ` ${current}` : current);
  return out.join(CRLF);
}

/**
 * Quote a parameter value per RFC 6350 §3.3 when it contains characters that
 * would break the header grammar. Embedded double-quotes and newlines are not
 * representable in a quoted param, so they are stripped.
 */
function escapeParamValue(value: string): string {
  const cleaned = value.replace(/["\r\n]/g, "");
  return /[;:,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/** Build a property line `[group.]NAME[;TYPE=type]:value` (value pre-escaped). */
function emitLine(
  name: string,
  value: string,
  options?: { type?: string; group?: string },
): string {
  const prefix = options?.group ? `${options.group}.` : "";
  const typeParam = options?.type
    ? `;TYPE=${escapeParamValue(options.type.toUpperCase())}`
    : "";
  return foldLine(`${prefix}${name}${typeParam}:${value}`);
}

/** Build a property line with arbitrary parameters (value pre-escaped). */
function emitWithParams(
  name: string,
  value: string,
  params: Array<[string, string]>,
): string {
  const paramStr = params
    .map(([k, v]) => `;${k}=${escapeParamValue(v)}`)
    .join("");
  return foldLine(`${name}${paramStr}:${value}`);
}

function addressValue(address: ContactAddress): string {
  return [
    address.poBox ?? "",
    "",
    address.street ?? "",
    address.city ?? "",
    address.region ?? "",
    address.postalCode ?? "",
    address.country ?? "",
  ]
    .map(escapeText)
    .join(";");
}

function structuredName(parts: string[]): string {
  const padded = [...parts];
  while (padded.length < 5) padded.push("");
  return padded.slice(0, 5).map(escapeText).join(";");
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

/** Track and allocate fresh `item N` groups that do not collide with existing. */
function makeGroupAllocator(records: RawRecord[]): () => string {
  let max = 0;
  for (const record of records) {
    const match = record.group ? /^item(\d+)$/.exec(record.group) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  let next = max;
  return () => `item${++next}`;
}

/** Read the existing structured value (`N`, `ORG`) components, or empty. */
function existingComponents(records: RawRecord[], name: string): string[] {
  const record = records.find((r) => r.name === name && !r.group);
  return record ? splitComponents(record.rawValue) : [];
}

/**
 * Apply the contact's set fields onto the raw vCard, rewriting only the
 * properties the contact explicitly changes and copying every other line
 * through verbatim. Used for updates so unmanaged data is never corrupted.
 */
export function patchRawVCard(raw: string, contact: Contact): string {
  const records = parseRecords(raw);
  const allocGroup = makeGroupAllocator(records);

  // Names whose existing records (and their grouped siblings) get replaced.
  const replaceNames = new Set<string>();
  const mark = (value: unknown, name: string): void => {
    if (value !== undefined) replaceNames.add(name);
  };
  mark(contact.fullName, "fn");
  if (hasNameParts(contact)) replaceNames.add("n");
  mark(contact.nickname, "nickname");
  if (contact.organization !== undefined || contact.department !== undefined) {
    replaceNames.add("org");
  }
  mark(contact.title, "title");
  mark(contact.categories, "categories");
  mark(contact.birthday, "bday");
  mark(contact.note, "note");
  mark(contact.phones, "tel");
  mark(contact.emails, "email");
  mark(contact.urls, "url");
  mark(contact.addresses, "adr");
  mark(contact.instantMessages, "impp");
  mark(contact.socialProfiles, "x-socialprofile");
  mark(contact.relatedNames, "x-abrelatednames");
  mark(contact.dates, "x-abdate");
  mark(contact.photo, "photo");

  // Groups attached to any replaced record are removed wholesale so grouped
  // labels (item N.X-ABLabel) never outlive the value they annotate.
  const replaceGroups = new Set<string>();
  for (const record of records) {
    if (replaceNames.has(record.name) && record.group) {
      replaceGroups.add(record.group);
    }
  }

  // Custom fields upsert by (name, group); unmentioned customs are untouched.
  const customKeys = new Set<string>();
  for (const field of contact.custom ?? []) {
    customKeys.add(customKey(field.key, field.group ?? null));
  }

  const newLines = buildNewLines(contact, records, allocGroup);

  const head: string[] = [];
  let endLines: string[] = ["END:VCARD"];
  for (const record of records) {
    if (record.name === "end") {
      endLines = record.physical;
      continue;
    }
    if (replaceNames.has(record.name)) continue;
    if (record.group && replaceGroups.has(record.group)) continue;
    if (customKeys.has(customKey(record.rawName, record.rawGroup))) continue;
    head.push(...record.physical);
  }

  return [...head, ...newLines, ...endLines].join(CRLF);
}

function customKey(name: string, group: string | null): string {
  return `${name.toLowerCase()} ${(group ?? "").toLowerCase()}`;
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

/** Build the replacement / new property lines for the fields the contact sets. */
function buildNewLines(
  contact: Contact,
  records: RawRecord[],
  allocGroup: () => string,
): string[] {
  const lines: string[] = [];

  if (contact.uid !== undefined && !records.some((r) => r.name === "uid")) {
    lines.push(emitLine("UID", escapeText(contact.uid)));
  }
  if (contact.fullName !== undefined) {
    lines.push(emitLine("FN", escapeText(contact.fullName)));
  }
  if (hasNameParts(contact)) {
    const existing = existingComponents(records, "n");
    const parts = existing.length > 0 ? existing : ["", "", "", "", ""];
    const order: Array<keyof Contact> = [
      "lastName",
      "firstName",
      "middleName",
      "prefix",
      "suffix",
    ];
    order.forEach((field, index) => {
      const value = contact[field];
      if (typeof value === "string") parts[index] = value;
    });
    lines.push(emitLine("N", structuredName(parts)));
  }
  if (contact.nickname !== undefined) {
    lines.push(emitLine("NICKNAME", escapeText(contact.nickname)));
  }
  if (contact.organization !== undefined || contact.department !== undefined) {
    const existing = existingComponents(records, "org");
    const parts = existing.length > 0 ? existing : ["", ""];
    while (parts.length < 2) parts.push("");
    if (contact.organization !== undefined) parts[0] = contact.organization;
    if (contact.department !== undefined) parts[1] = contact.department;
    lines.push(emitLine("ORG", parts.map(escapeText).join(";")));
  }
  if (contact.title !== undefined) {
    lines.push(emitLine("TITLE", escapeText(contact.title)));
  }
  if (contact.categories !== undefined) {
    lines.push(
      emitLine("CATEGORIES", contact.categories.map(escapeText).join(",")),
    );
  }
  if (contact.birthday !== undefined) {
    lines.push(emitLine("BDAY", escapeText(contact.birthday)));
  }
  if (contact.note !== undefined) {
    lines.push(emitLine("NOTE", escapeText(contact.note)));
  }
  for (const phone of contact.phones ?? []) {
    if (!phone.value) continue;
    lines.push(
      emitLine(
        "TEL",
        escapeText(phone.value),
        phone.type ? { type: phone.type } : undefined,
      ),
    );
  }
  for (const email of contact.emails ?? []) {
    if (!email.value) continue;
    lines.push(
      emitLine(
        "EMAIL",
        escapeText(email.value),
        email.type ? { type: email.type } : undefined,
      ),
    );
  }
  for (const url of contact.urls ?? []) {
    if (!url) continue;
    lines.push(emitLine("URL", escapeText(url)));
  }
  for (const address of contact.addresses ?? []) {
    lines.push(
      emitLine(
        "ADR",
        addressValue(address),
        address.type ? { type: address.type } : undefined,
      ),
    );
  }
  if (contact.photo !== undefined) {
    const mediaType = (contact.photo.mediaType ?? "JPEG").toUpperCase();
    lines.push(
      foldLine(`PHOTO;ENCODING=b;TYPE=${mediaType}:${contact.photo.data}`),
    );
  }
  for (const im of contact.instantMessages ?? []) {
    if (!im.handle) continue;
    const scheme = (im.service ?? "x-apple").toLowerCase();
    const value = `${scheme}:${escapeText(im.handle)}`;
    lines.push(
      im.service
        ? emitWithParams("IMPP", value, [["X-SERVICE-TYPE", im.service]])
        : emitLine("IMPP", value),
    );
  }
  for (const profile of contact.socialProfiles ?? []) {
    if (!profile.url) continue;
    // Apple keys social services by a lowercase `type` id (e.g. `twitter`),
    // so emit the param verbatim rather than upper-casing it.
    lines.push(
      profile.service
        ? emitWithParams("X-SOCIALPROFILE", escapeText(profile.url), [
            ["type", profile.service],
          ])
        : emitLine("X-SOCIALPROFILE", escapeText(profile.url)),
    );
  }
  for (const relation of contact.relatedNames ?? []) {
    if (!relation.name) continue;
    const group = allocGroup();
    lines.push(
      emitLine("X-ABRELATEDNAMES", escapeText(relation.name), { group }),
    );
    lines.push(emitLine("X-ABLabel", escapeText(relation.label), { group }));
  }
  for (const date of contact.dates ?? []) {
    if (!date.date) continue;
    const group = allocGroup();
    lines.push(emitLine("X-ABDATE", escapeText(date.date), { group }));
    lines.push(emitLine("X-ABLabel", escapeText(date.label), { group }));
  }
  for (const field of contact.custom ?? []) {
    if (!field.key) continue;
    const options: { type?: string; group?: string } = {};
    if (field.type) options.type = field.type;
    if (field.group) options.group = field.group;
    lines.push(emitLine(field.key, escapeText(field.value), options));
  }

  return lines;
}
