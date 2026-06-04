/**
 * Raw vCard line model and surgical patcher.
 *
 * Data integrity is the load-bearing requirement: an update against a real
 * iCloud address book must never corrupt or drop a single byte of data the
 * model does not understand. Re-serializing through `vcf` mangles mixed-case
 * property names and upper-cases param values, so we operate on the raw text.
 *
 * The patcher does per-record diff/merge, NOT wholesale replacement. Each
 * item the read path returns (a `ContactPhone`, `ContactEmail`, etc.) carries
 * a hidden Symbol-keyed back-ref to its source `RawRecord` via
 * {@link RECORD_ORIGIN}. On patch, the merger pairs each new item with an
 * existing record (by ref, then by value), rewrites ONLY the bytes the user
 * changed (preserving every other parameter, the group prefix, and any
 * grouped `X-ABLabel` sibling), removes unmatched origin records, and appends
 * fresh records for new items. Anything not modeled survives by default,
 * forever, without ever needing the `Contact` schema to grow.
 *
 * @experimental
 */

import type {
  Contact,
  ContactAddress,
  ContactDate,
  ContactEmail,
  ContactField,
  ContactInstantMessage,
  ContactPhone,
  ContactPhoto,
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

/**
 * Side-channel association from each parsed Contact item to its source raw
 * record. Stored in a `WeakMap` rather than as a property on the item so it
 * is invisible to deep-equality matchers, `JSON.stringify`, and any other
 * structural inspection of the object — it does not pollute the public shape.
 *
 * Trade-off: the ref does NOT survive `{...item}` spread or `structuredClone`,
 * because the new object has a different identity. The patcher falls back to
 * value-equality matching when no ref is found, which handles the typical
 * route-transform case correctly. Cards where two records share the same
 * value (e.g. duplicate phones with different `TYPE` params) are the
 * pathological case the ref disambiguates; routes that materially edit such
 * records should preserve the items by reference rather than spreading.
 *
 * @internal
 */
const originRefs = new WeakMap<object, RawRecord>();

/** Read the origin record back-ref from a parsed Contact item, if any. */
function readOrigin(item: object): RawRecord | undefined {
  return originRefs.get(item);
}

/** Attach an origin back-ref to a Contact item. Returns the same item. */
function attachOrigin<T extends object>(item: T, origin: RawRecord): T {
  originRefs.set(item, origin);
  return item;
}

/**
 * Return a copy of a parsed Contact item with the given fields overridden,
 * preserving the origin back-ref so the patcher can still rewrite the source
 * record in place (preserving every param / group / labeled sibling the
 * structured model does not surface).
 *
 * Use this in route transforms instead of `{...item, value: "new"}` so the
 * ref survives:
 *
 * ```ts
 * const updated = phones.map(p =>
 *   p.value === '+1...' ? withChanges(p, { value: '+2...' }) : p,
 * );
 * ```
 *
 * Items constructed from scratch (`{value: '+1...'}`) have no ref to preserve;
 * the patcher falls back to value-equality matching for them.
 */
export function withChanges<T extends object>(item: T, changes: Partial<T>): T {
  const next = { ...item, ...changes } as T;
  const ref = originRefs.get(item);
  if (ref) originRefs.set(next, ref);
  return next;
}

export interface RawRecord {
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
  /**
   * Header bytes of the original logical line: everything before the first
   * unquoted colon (group prefix + property name + every parameter, in their
   * original casing). Used by the patcher to preserve every byte the
   * structured model does not manage when rewriting a record's value.
   */
  header: string;
  /** Unescaped value (after the first colon, with line folding undone). */
  value: string;
  /** Raw (still-escaped) value, for component-accurate structured splitting. */
  rawValue: string;
  /** Physical lines for re-emit. May be rebuilt by the patcher; never mutated in place. */
  physical: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split raw vCard text into records, grouping folded continuation lines. */
export function parseRecords(raw: string): RawRecord[] {
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
    // Blank physical lines between records (some exporters emit them around
    // BEGIN:VCARD) are not header lines and must not seed phantom records.
    if (line === "") continue;
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
    // `TYPE` may repeat (e.g. TYPE=HOME;TYPE=pref) or carry comma-separated
    // values inside one param (e.g. TYPE=HOME,PREF). Walk every candidate
    // across both shapes and pick the first non-pref one.
    if (key === "type" && type === null && paramValue) {
      for (const candidate of paramValue.split(",")) {
        const lowered = candidate.trim().toLowerCase();
        if (lowered && lowered !== "pref") {
          type = lowered;
          break;
        }
      }
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
    header,
    value: unescapeText(value),
    rawValue: value,
    physical: lines,
  };
}

/**
 * Split a vCard value on `separator` characters that are not preceded by a
 * backslash, then unescape each segment. Walking with explicit escape tracking
 * handles `\,`/`\;` (escaped separator) and `\\,`/`\\;` (escaped backslash +
 * separator) correctly, which a naive `split()` over the unescaped value does
 * not.
 */
function splitOnUnescaped(rawValue: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i];
    if (ch === "\\" && i + 1 < rawValue.length) {
      current += ch + rawValue[i + 1];
      i++;
    } else if (ch === separator) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(unescapeText);
}

/** Split a structured value (`N`, `ADR`, `ORG`) into components on `;`. */
function splitComponents(rawValue: string): string[] {
  return splitOnUnescaped(rawValue, ";");
}

/** Split a structured value WITHOUT unescaping each part — preserves raw bytes. */
function splitComponentsRaw(rawValue: string): string[] {
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
  return parts;
}

/**
 * Read `CATEGORIES` as a comma-separated list, splitting on unescaped commas
 * (so a category whose literal name contains `,` survives the round trip).
 */
export function extractCategories(records: RawRecord[]): string[] {
  const record = records.find((r) => r.name === "categories" && !r.group);
  if (!record) return [];
  return splitOnUnescaped(record.rawValue, ",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Read the unescaped value of a top-level (ungrouped) text property such as
 * `FN`, `TITLE`, `NICKNAME`, `NOTE`, `UID`, `BDAY`. The `vcf` library does not
 * decode RFC 6350 text escapes (`\n`, `\,`, `\;`), so callers that need a
 * round-trip-correct value go through the raw layer instead.
 */
export function extractTextValue(
  records: RawRecord[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const record = records.find((r) => r.name === lower && !r.group);
  if (!record) return undefined;
  const value = record.value.trim();
  return value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Reading: array fields. Each item gets a hidden `RECORD_ORIGIN` back-ref so
// the patcher can mutate exactly the source record on update, preserving
// every param/group/sibling the structured model does not surface.
// ---------------------------------------------------------------------------

/** Decode Apple's `_$!<Label>!$_` wrapper to a plain label. */
function decodeLabel(label: string): string {
  const match = /^_\$!<(.+)>!\$_$/.exec(label);
  return match ? (match[1] as string) : label;
}

/**
 * Extract labeled dates (`X-ABDATE` grouped with `X-ABLabel`). The optional
 * `labels` parameter lets a caller that already computed the group-label map
 * (e.g. `parseVCard` reuses it for `extractRelatedNames`) avoid a second walk.
 */
export function extractDates(
  records: RawRecord[],
  labels: Map<string, string> = groupLabels(records),
): ContactDate[] {
  const dates: ContactDate[] = [];
  for (const record of records) {
    if (record.name !== "x-abdate") continue;
    const label = record.group ? labels.get(record.group) : undefined;
    dates.push(
      attachOrigin({ label: label ?? "other", date: record.value }, record),
    );
  }
  return dates;
}

/** Build a group -> decoded label map from `X-ABLabel` records. */
export function groupLabels(records: RawRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const record of records) {
    if (record.name === "x-ablabel" && record.group) {
      labels.set(record.group, decodeLabel(record.value));
    }
  }
  return labels;
}

/** Extract instant-messaging handles (`IMPP`, iCloud `X-SERVICE-TYPE`). */
export function extractInstantMessages(
  records: RawRecord[],
): ContactInstantMessage[] {
  const out: ContactInstantMessage[] = [];
  for (const record of records) {
    if (record.name !== "impp") continue;
    const { scheme, handle } = parseImppValue(record.value);
    const service = record.params["x-service-type"];
    const im: ContactInstantMessage = { handle };
    if (service) im.service = service;
    if (scheme) im.scheme = scheme;
    out.push(attachOrigin(im, record));
  }
  return out;
}

function parseImppValue(value: string): { scheme?: string; handle: string } {
  const colon = value.indexOf(":");
  if (colon < 0) return { handle: value };
  return { scheme: value.slice(0, colon), handle: value.slice(colon + 1) };
}

/** Extract social-media profiles (iCloud `X-SOCIALPROFILE`). */
export function extractSocialProfiles(
  records: RawRecord[],
): ContactSocialProfile[] {
  const out: ContactSocialProfile[] = [];
  for (const record of records) {
    if (record.name !== "x-socialprofile") continue;
    const profile: ContactSocialProfile = { url: record.value };
    if (record.type) profile.service = record.type;
    out.push(attachOrigin(profile, record));
  }
  return out;
}

/** Extract related people (`X-ABRELATEDNAMES` grouped with `X-ABLabel`). */
export function extractRelatedNames(
  records: RawRecord[],
  labels: Map<string, string> = groupLabels(records),
): ContactRelatedName[] {
  const out: ContactRelatedName[] = [];
  for (const record of records) {
    if (record.name !== "x-abrelatednames") continue;
    const label = record.group ? labels.get(record.group) : undefined;
    out.push(
      attachOrigin({ label: label ?? "other", name: record.value }, record),
    );
  }
  return out;
}

function component(parts: string[], index: number): string | undefined {
  const value = parts[index]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Read the structured `N` name parts, splitting on unescaped separators. */
export function extractName(
  records: RawRecord[],
): Pick<
  Contact,
  "firstName" | "lastName" | "middleName" | "prefix" | "suffix"
> {
  const record = records.find((r) => r.name === "n" && !r.group);
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
  records: RawRecord[],
): Pick<Contact, "organization" | "department"> {
  const record = records.find((r) => r.name === "org" && !r.group);
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
export function extractAddresses(records: RawRecord[]): ContactAddress[] {
  const out: ContactAddress[] = [];
  for (const record of records) {
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
    // Index 1 is the RFC 6350 "extended address" component (apartment / suite).
    // It is intentionally NOT exposed on the model, but the original raw bytes
    // are preserved by the patcher via the origin back-ref, so a round trip
    // does not drop "Apt 4B".
    if (Object.keys(address).length > 0)
      out.push(attachOrigin(address, record));
  }
  return out;
}

/** Read TEL records into `ContactPhone[]`, attaching origin back-refs. */
export function extractPhones(records: RawRecord[]): ContactPhone[] {
  const out: ContactPhone[] = [];
  for (const record of records) {
    if (record.name !== "tel") continue;
    const value = record.value.trim();
    if (!value) continue;
    const phone: ContactPhone = { value };
    if (record.type) phone.type = record.type;
    out.push(attachOrigin(phone, record));
  }
  return out;
}

/** Read EMAIL records into `ContactEmail[]`, attaching origin back-refs. */
export function extractEmails(records: RawRecord[]): ContactEmail[] {
  const out: ContactEmail[] = [];
  for (const record of records) {
    if (record.name !== "email") continue;
    const value = record.value.trim();
    if (!value) continue;
    const email: ContactEmail = { value };
    if (record.type) email.type = record.type;
    out.push(attachOrigin(email, record));
  }
  return out;
}

/** Read URL records into a string list. */
export function extractUrls(records: RawRecord[]): string[] {
  const out: string[] = [];
  for (const record of records) {
    if (record.name !== "url") continue;
    const value = record.value.trim();
    if (value) out.push(value);
  }
  return out;
}

/**
 * Read PHOTO record into `ContactPhoto`, attaching origin back-ref so the
 * patcher preserves the original ENCODING/TYPE params on update.
 */
export function extractPhoto(records: RawRecord[]): ContactPhoto | undefined {
  const record = records.find((r) => r.name === "photo");
  if (!record) return undefined;
  const data = record.value.trim();
  if (!data) return undefined;
  const photo: ContactPhoto = { data };
  if (record.type) photo.mediaType = record.type.toUpperCase();
  attachOrigin(photo, record);
  return photo;
}

/**
 * Extract properties outside the managed model (e.g. arbitrary `X-` fields) so
 * callers can read them. Managed and grouped-label properties are excluded.
 */
export function extractCustomFields(records: RawRecord[]): ContactField[] {
  const fields: ContactField[] = [];
  for (const record of records) {
    if (!record.rawName) continue;
    if (MODELED_NAMES.has(record.name)) continue;
    const field: ContactField = { key: record.rawName, value: record.value };
    if (record.type) field.type = record.type;
    if (record.rawGroup) field.group = record.rawGroup;
    fields.push(attachOrigin(field, record));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Emit / escape primitives
// ---------------------------------------------------------------------------

/**
 * Escape a value per RFC 6350 (backslash, comma, semicolon, newline). Used for
 * both free-text values and individual components of structured values (`N`,
 * `ADR`), where the literal `;` separators are added afterward by the caller.
 * `\r`, `\r\n` and `\n` all collapse to the `\n` escape so a stray Windows
 * line ending in user-supplied text cannot break the on-wire vCard grammar.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
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

// ---------------------------------------------------------------------------
// Record mutators: rebuild the physical bytes for a record while preserving
// header parameters / group prefix the model does not surface.
// ---------------------------------------------------------------------------

/**
 * Rebuild a record's physical lines from a header string + raw value, so the
 * patcher can rewrite the value bytes (and optionally update params) without
 * touching anything else.
 */
function withRebuiltPhysical(
  record: RawRecord,
  header: string,
  rawValue: string,
): RawRecord {
  const folded = foldLine(`${header}:${rawValue}`);
  return {
    ...record,
    header,
    rawValue,
    value: unescapeText(rawValue),
    physical: folded.split(CRLF),
  };
}

/** Replace the `TYPE` param in a header, preserving every other param. */
function replaceTypeInHeader(
  header: string,
  newType: string | undefined,
): string {
  const segments = splitUnquoted(header);
  const nameSeg = segments[0] ?? "";
  const otherParams = segments
    .slice(1)
    .filter((s) => !/^type\s*=/i.test(s.trim()));
  if (newType !== undefined && newType.length > 0) {
    return [nameSeg, `TYPE=${escapeParamValue(newType)}`, ...otherParams].join(
      ";",
    );
  }
  return [nameSeg, ...otherParams].join(";");
}

/** Replace (or add) a named param in a header, preserving every other param. */
function setParamInHeader(
  header: string,
  paramName: string,
  newValue: string | undefined,
): string {
  const segments = splitUnquoted(header);
  const nameSeg = segments[0] ?? "";
  const lowered = paramName.toLowerCase();
  const otherParams = segments
    .slice(1)
    .filter((s) => !new RegExp(`^${lowered}\\s*=`, "i").test(s.trim()));
  if (newValue !== undefined && newValue.length > 0) {
    return [
      nameSeg,
      `${paramName}=${escapeParamValue(newValue)}`,
      ...otherParams,
    ].join(";");
  }
  return [nameSeg, ...otherParams].join(";");
}

/** Build a fresh record from scratch (no origin). */
function buildFreshRecord(opts: {
  name: string;
  rawValue: string;
  type?: string;
  group?: string;
  extraParams?: Array<[string, string]>;
}): RawRecord {
  const prefix = opts.group ? `${opts.group}.` : "";
  const paramSegs: string[] = [];
  if (opts.type) paramSegs.push(`TYPE=${escapeParamValue(opts.type)}`);
  for (const [k, v] of opts.extraParams ?? []) {
    paramSegs.push(`${k}=${escapeParamValue(v)}`);
  }
  const header = [`${prefix}${opts.name}`, ...paramSegs].join(";");
  const folded = foldLine(`${header}:${opts.rawValue}`);
  const params: Record<string, string> = {};
  if (opts.type) params["type"] = opts.type;
  for (const [k, v] of opts.extraParams ?? []) {
    params[k.toLowerCase()] = v;
  }
  return {
    name: opts.name.toLowerCase(),
    group: opts.group ? opts.group.toLowerCase() : null,
    rawName: opts.name,
    rawGroup: opts.group ?? null,
    type: opts.type ? opts.type.toLowerCase() : null,
    params,
    header,
    rawValue: opts.rawValue,
    value: unescapeText(opts.rawValue),
    physical: folded.split(CRLF),
  };
}

// ---------------------------------------------------------------------------
// Per-record matching helpers used by every array-field merger.
// ---------------------------------------------------------------------------

interface PairResult<T> {
  /** For each new item, the matched origin record (if any). */
  pairs: Array<{ item: T; origin?: RawRecord }>;
  /** Origin records that were claimed by a new item. */
  claimed: Set<RawRecord>;
}

/**
 * Stable content-based identifier for a record: the original physical bytes.
 * The patcher always reparses the raw text into fresh `RawRecord` instances,
 * so origin refs stored at parse time cannot be matched by identity. Comparing
 * the physical bytes (which are immutable for the lifetime of a record)
 * recovers the "same record" relationship across re-parses.
 */
function recordKey(r: RawRecord): string {
  return r.physical.join(CRLF);
}

/**
 * Pair each item in `newItems` with a candidate origin record by:
 *   1. The `RECORD_ORIGIN` back-ref attached during read, matched by physical
 *      bytes (so refs survive the patcher's internal re-parse).
 *   2. Value equality (`valueOf(item) === record.value`), first unclaimed wins.
 * Items with no match are appended fresh; origins not claimed are removed.
 */
function pairItems<T extends object>(
  newItems: T[],
  candidates: RawRecord[],
  valueOf: (item: T) => string,
): PairResult<T> {
  const claimed = new Set<RawRecord>();
  const pairs: Array<{ item: T; origin?: RawRecord }> = [];
  for (const item of newItems) {
    const ref = readOrigin(item);
    if (ref) {
      const refKey = recordKey(ref);
      const refMatch = candidates.find(
        (c) => !claimed.has(c) && recordKey(c) === refKey,
      );
      if (refMatch) {
        claimed.add(refMatch);
        pairs.push({ item, origin: refMatch });
        continue;
      }
    }
    const v = valueOf(item);
    const match = candidates.find((r) => !claimed.has(r) && r.value === v);
    if (match) {
      claimed.add(match);
      pairs.push({ item, origin: match });
    } else {
      pairs.push({ item });
    }
  }
  return { pairs, claimed };
}

/**
 * Apply an array-field merge plan against a records list:
 *   - paired items: rewrite the origin record (preserving header bytes the
 *     merger does not change) and keep it in place.
 *   - unclaimed origin records (and their `X-ABLabel` siblings): removed.
 *   - unpaired new items: appended just before END:VCARD.
 *
 * `rewriteOrigin` returns the updated record (typically via
 * `withRebuiltPhysical`). `buildFresh` returns one or more records for an
 * unmatched new item (multiple records used for labeled pairs like
 * `X-ABRELATEDNAMES + X-ABLabel`).
 */
function applyArrayMerge<T>(
  records: RawRecord[],
  pairs: Array<{ item: T; origin?: RawRecord }>,
  claimed: Set<RawRecord>,
  candidates: Set<RawRecord>,
  rewriteOrigin: (origin: RawRecord, item: T) => RawRecord,
  buildFresh: (item: T) => RawRecord[],
): RawRecord[] {
  // 1. Compute groups whose primary record is being removed; strip their
  //    `X-ABLabel` siblings too. (A label without its labeled value is
  //    meaningless.)
  const removedGroups = new Set<string>();
  for (const r of records) {
    if (candidates.has(r) && !claimed.has(r) && r.group) {
      removedGroups.add(r.group);
    }
  }

  // 2. Walk records: rewrite claimed originals, drop unclaimed candidates and
  //    their label siblings, keep everything else.
  const result: RawRecord[] = [];
  const pairByOrigin = new Map<RawRecord, T>();
  for (const { item, origin } of pairs) {
    if (origin) pairByOrigin.set(origin, item);
  }
  for (const r of records) {
    if (candidates.has(r)) {
      const item = pairByOrigin.get(r);
      if (item !== undefined) {
        result.push(rewriteOrigin(r, item));
      }
      // else: dropped (the new array doesn't include this item)
      continue;
    }
    if (r.name === "x-ablabel" && r.group && removedGroups.has(r.group)) {
      continue; // label sibling of a removed grouped primary
    }
    result.push(r);
  }

  // 3. Append fresh records for unmatched new items, just before END:VCARD.
  const fresh: RawRecord[] = [];
  for (const { item, origin } of pairs) {
    if (origin) continue;
    fresh.push(...buildFresh(item));
  }
  return insertBeforeEnd(result, fresh);
}

function insertBeforeEnd(
  records: RawRecord[],
  inserts: RawRecord[],
): RawRecord[] {
  if (inserts.length === 0) return records;
  const endIdx = records.findIndex((r) => r.name === "end");
  if (endIdx < 0) return [...records, ...inserts];
  return [...records.slice(0, endIdx), ...inserts, ...records.slice(endIdx)];
}

// ---------------------------------------------------------------------------
// Per-field mergers
// ---------------------------------------------------------------------------

/**
 * Merge a singleton text property (FN, NICKNAME, TITLE, NOTE, UID, BDAY):
 *   - field undefined: leave any existing record untouched.
 *   - field set: rewrite the existing record's value (preserving header), or
 *     append a fresh record if none exists.
 *
 * Special case for `uid`: when the existing card has no UID record and the
 * contact also did not supply one, no UID line is emitted. The write path
 * compensates by synthesizing a UID into the contact before calling the
 * patcher, so `result.uid` always matches what is persisted.
 */
function mergeTextSingleton(
  records: RawRecord[],
  name: string,
  newValue: string | undefined,
): RawRecord[] {
  if (newValue === undefined) return records;
  const lower = name.toLowerCase();
  const existing = records.find((r) => r.name === lower && !r.group);
  const rawValue = escapeText(newValue);
  if (existing) {
    return records.map((r) =>
      r === existing
        ? withRebuiltPhysical(existing, existing.header, rawValue)
        : r,
    );
  }
  return insertBeforeEnd(records, [
    buildFreshRecord({ name: name.toUpperCase(), rawValue }),
  ]);
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

/** Merge structured `N` (5 components: family, given, additional, prefix, suffix). */
function mergeName(records: RawRecord[], contact: Contact): RawRecord[] {
  if (!hasNameParts(contact)) return records;
  const existing = records.find((r) => r.name === "n" && !r.group);
  // Start from existing RAW components (preserve escaping), pad to 5, then
  // overlay only the slots the user explicitly set.
  const baseRaw: string[] = existing
    ? splitComponentsRaw(existing.rawValue)
    : [];
  const parts: string[] = ["", "", "", "", ""];
  for (let i = 0; i < 5; i++) {
    parts[i] = baseRaw[i] ?? "";
  }
  const order: Array<keyof Contact> = [
    "lastName",
    "firstName",
    "middleName",
    "prefix",
    "suffix",
  ];
  order.forEach((field, index) => {
    const value = contact[field];
    if (typeof value === "string") parts[index] = escapeText(value);
  });
  const rawValue = parts.join(";");
  if (existing) {
    return records.map((r) =>
      r === existing
        ? withRebuiltPhysical(existing, existing.header, rawValue)
        : r,
    );
  }
  return insertBeforeEnd(records, [buildFreshRecord({ name: "N", rawValue })]);
}

/** Merge structured `ORG` (organization; department). */
function mergeOrg(records: RawRecord[], contact: Contact): RawRecord[] {
  if (contact.organization === undefined && contact.department === undefined) {
    return records;
  }
  const existing = records.find((r) => r.name === "org" && !r.group);
  const baseRaw = existing ? splitComponentsRaw(existing.rawValue) : [];
  const parts: string[] = [baseRaw[0] ?? "", baseRaw[1] ?? ""];
  // ORG may have extra components past department (units); preserve them.
  for (let i = 2; i < baseRaw.length; i++) parts.push(baseRaw[i] ?? "");
  if (contact.organization !== undefined)
    parts[0] = escapeText(contact.organization);
  if (contact.department !== undefined)
    parts[1] = escapeText(contact.department);
  const rawValue = parts.join(";");
  if (existing) {
    return records.map((r) =>
      r === existing
        ? withRebuiltPhysical(existing, existing.header, rawValue)
        : r,
    );
  }
  return insertBeforeEnd(records, [
    buildFreshRecord({ name: "ORG", rawValue }),
  ]);
}

/** Merge `CATEGORIES` (comma-separated). */
function mergeCategories(
  records: RawRecord[],
  categories: string[] | undefined,
): RawRecord[] {
  if (categories === undefined) return records;
  const existing = records.find((r) => r.name === "categories" && !r.group);
  const rawValue = categories.map(escapeText).join(",");
  if (existing) {
    return records.map((r) =>
      r === existing
        ? withRebuiltPhysical(existing, existing.header, rawValue)
        : r,
    );
  }
  return insertBeforeEnd(records, [
    buildFreshRecord({ name: "CATEGORIES", rawValue }),
  ]);
}

/** Merge `PHOTO`. */
function mergePhoto(
  records: RawRecord[],
  photo: ContactPhoto | undefined,
): RawRecord[] {
  if (photo === undefined) return records;
  // Strip every whitespace character from the base64 payload before folding:
  // some encoders chunk base64 with CR/LF, and any embedded line break would
  // be re-emitted verbatim, splitting the property and corrupting the card.
  const cleanData = photo.data.replace(/\s+/g, "");
  // Match the origin ref by physical bytes (the patcher re-parses, so identity
  // does not survive); fall through to the first PHOTO record otherwise.
  const ref = readOrigin(photo);
  const refKey = ref ? recordKey(ref) : undefined;
  const origin =
    (refKey ? records.find((r) => recordKey(r) === refKey) : undefined) ??
    records.find((r) => r.name === "photo");
  if (origin && origin.name === "photo") {
    let header = origin.header;
    if (photo.mediaType !== undefined) {
      header = setParamInHeader(header, "TYPE", photo.mediaType.toUpperCase());
    }
    return records.map((r) =>
      r === origin ? withRebuiltPhysical(origin, header, cleanData) : r,
    );
  }
  const mediaType = (photo.mediaType ?? "JPEG").toUpperCase();
  return insertBeforeEnd(records, [
    buildFreshRecord({
      name: "PHOTO",
      rawValue: cleanData,
      extraParams: [
        ["ENCODING", "b"],
        ["TYPE", mediaType],
      ],
    }),
  ]);
}

/** Merge TEL records (per-record diff: value, type, header preserved). */
function mergePhones(
  records: RawRecord[],
  phones: ContactPhone[] | undefined,
): RawRecord[] {
  if (phones === undefined) return records;
  const candidates = records.filter((r) => r.name === "tel");
  const { pairs, claimed } = pairItems(phones, candidates, (p) => p.value);
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, phone) => {
      const newRawValue = escapeText(phone.value);
      // If the user-supplied type differs from the origin's, update only the
      // TYPE param. Otherwise preserve the origin header verbatim (PREF flag,
      // X-ABLABEL params, etc. all survive).
      const needsTypeUpdate = (phone.type ?? null) !== (origin.type ?? null);
      const header = needsTypeUpdate
        ? replaceTypeInHeader(origin.header, phone.type)
        : origin.header;
      return withRebuiltPhysical(origin, header, newRawValue);
    },
    (phone) => [
      buildFreshRecord({
        name: "TEL",
        rawValue: escapeText(phone.value),
        ...(phone.type !== undefined ? { type: phone.type } : {}),
      }),
    ],
  );
}

/** Merge EMAIL records. */
function mergeEmails(
  records: RawRecord[],
  emails: ContactEmail[] | undefined,
): RawRecord[] {
  if (emails === undefined) return records;
  const candidates = records.filter((r) => r.name === "email");
  const { pairs, claimed } = pairItems(emails, candidates, (e) => e.value);
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, email) => {
      const newRawValue = escapeText(email.value);
      const needsTypeUpdate = (email.type ?? null) !== (origin.type ?? null);
      const header = needsTypeUpdate
        ? replaceTypeInHeader(origin.header, email.type)
        : origin.header;
      return withRebuiltPhysical(origin, header, newRawValue);
    },
    (email) => [
      buildFreshRecord({
        name: "EMAIL",
        rawValue: escapeText(email.value),
        ...(email.type !== undefined ? { type: email.type } : {}),
      }),
    ],
  );
}

/** Merge URL records (simple strings; no type). */
function mergeUrls(
  records: RawRecord[],
  urls: string[] | undefined,
): RawRecord[] {
  if (urls === undefined) return records;
  const candidates = records.filter((r) => r.name === "url");
  // URLs are strings; the only way to match against existing is by value.
  // The new array carries no origin refs, so pair by value only.
  const claimed = new Set<RawRecord>();
  const pairs: Array<{ item: string; origin?: RawRecord }> = [];
  for (const url of urls) {
    const match = candidates.find((r) => !claimed.has(r) && r.value === url);
    if (match) {
      claimed.add(match);
      pairs.push({ item: url, origin: match });
    } else {
      pairs.push({ item: url });
    }
  }
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, url) =>
      withRebuiltPhysical(origin, origin.header, escapeText(url)),
    (url) => [buildFreshRecord({ name: "URL", rawValue: escapeText(url) })],
  );
}

/** Merge ADR records: per-record component-wise overlay preserves index 1. */
function mergeAddresses(
  records: RawRecord[],
  addresses: ContactAddress[] | undefined,
): RawRecord[] {
  if (addresses === undefined) return records;
  const candidates = records.filter((r) => r.name === "adr");
  // Match by street (best stable key for an ADR; falls back to ref).
  const { pairs, claimed } = pairItems(addresses, candidates, (a) =>
    buildAddressMatchKey(a),
  );
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, addr) => {
      // Read the existing 7 components RAW (preserve escaping) and overlay
      // ONLY the slots the user explicitly set. Index 1 (extended address /
      // apartment) is intentionally not on the model; preserving the original
      // raw bytes keeps it intact.
      const base = splitComponentsRaw(origin.rawValue);
      const parts: string[] = [];
      for (let i = 0; i < 7; i++) parts.push(base[i] ?? "");
      // Also preserve any trailing components past index 6.
      for (let i = 7; i < base.length; i++) parts.push(base[i] ?? "");
      if (addr.poBox !== undefined) parts[0] = escapeText(addr.poBox);
      if (addr.street !== undefined) parts[2] = escapeText(addr.street);
      if (addr.city !== undefined) parts[3] = escapeText(addr.city);
      if (addr.region !== undefined) parts[4] = escapeText(addr.region);
      if (addr.postalCode !== undefined) parts[5] = escapeText(addr.postalCode);
      if (addr.country !== undefined) parts[6] = escapeText(addr.country);
      const rawValue = parts.join(";");
      const needsTypeUpdate = (addr.type ?? null) !== (origin.type ?? null);
      const header = needsTypeUpdate
        ? replaceTypeInHeader(origin.header, addr.type)
        : origin.header;
      return withRebuiltPhysical(origin, header, rawValue);
    },
    (addr) => [
      buildFreshRecord({
        name: "ADR",
        rawValue: addressValueFresh(addr),
        ...(addr.type !== undefined ? { type: addr.type } : {}),
      }),
    ],
  );
}

function buildAddressMatchKey(a: ContactAddress): string {
  // ADR records have no naturally unique field; combine street+city+postal as
  // a heuristic. The origin back-ref handles the common case (read + edit +
  // write back through transforms); this fallback only fires when the user
  // constructs an address from scratch that happens to coincide with an
  // existing one.
  return [a.street ?? "", a.city ?? "", a.postalCode ?? ""].join("|");
}

function addressValueFresh(address: ContactAddress): string {
  // Fresh ADR (no origin): emit all 7 components, index 1 (extended address)
  // empty because the model does not surface it.
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

/** Merge IMPP records: preserves URI scheme via origin when handle unchanged. */
function mergeIMPP(
  records: RawRecord[],
  ims: ContactInstantMessage[] | undefined,
): RawRecord[] {
  if (ims === undefined) return records;
  const candidates = records.filter((r) => r.name === "impp");
  const { pairs, claimed } = pairItems(ims, candidates, (im) => im.handle);
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, im) => {
      // Preserve the origin's URI scheme by default; only override if the user
      // supplied a different `scheme` field.
      const { scheme: originScheme } = parseImppValue(origin.value);
      const scheme =
        im.scheme ?? originScheme ?? (im.service ?? "x-apple").toLowerCase();
      const rawValue = `${scheme}:${escapeText(im.handle)}`;
      // X-SERVICE-TYPE: update only if user changed it (origin preserved otherwise).
      const originService = origin.params["x-service-type"];
      const header =
        im.service !== undefined && im.service !== originService
          ? setParamInHeader(origin.header, "X-SERVICE-TYPE", im.service)
          : origin.header;
      return withRebuiltPhysical(origin, header, rawValue);
    },
    (im) => {
      const scheme = im.scheme ?? (im.service ?? "x-apple").toLowerCase();
      const rawValue = `${scheme}:${escapeText(im.handle)}`;
      return [
        buildFreshRecord({
          name: "IMPP",
          rawValue,
          ...(im.service
            ? {
                extraParams: [["X-SERVICE-TYPE", im.service]] as Array<
                  [string, string]
                >,
              }
            : {}),
        }),
      ];
    },
  );
}

/** Merge X-SOCIALPROFILE records. */
function mergeSocialProfiles(
  records: RawRecord[],
  profiles: ContactSocialProfile[] | undefined,
): RawRecord[] {
  if (profiles === undefined) return records;
  const candidates = records.filter((r) => r.name === "x-socialprofile");
  const { pairs, claimed } = pairItems(profiles, candidates, (p) => p.url);
  return applyArrayMerge(
    records,
    pairs,
    claimed,
    new Set(candidates),
    (origin, profile) => {
      const rawValue = escapeText(profile.url);
      // Apple stores the social service as a lowercase `type` param.
      const originService = origin.params["type"];
      const header =
        profile.service !== undefined && profile.service !== originService
          ? setParamInHeader(origin.header, "type", profile.service)
          : origin.header;
      return withRebuiltPhysical(origin, header, rawValue);
    },
    (profile) => [
      buildFreshRecord({
        name: "X-SOCIALPROFILE",
        rawValue: escapeText(profile.url),
        ...(profile.service
          ? {
              extraParams: [["type", profile.service]] as Array<
                [string, string]
              >,
            }
          : {}),
      }),
    ],
  );
}

/**
 * Merge a labeled primary + X-ABLabel sibling pair (X-ABRELATEDNAMES,
 * X-ABDATE). Matching is on the primary's value; the sibling is rewritten in
 * lockstep, preserving the original `item N` group prefix when paired.
 */
function mergeLabeledPair<T extends object>(
  records: RawRecord[],
  newItems: T[] | undefined,
  primaryName: string,
  valueOf: (item: T) => string,
  labelOf: (item: T) => string,
  allocGroup: () => string,
): RawRecord[] {
  if (newItems === undefined) return records;
  const candidates = records.filter((r) => r.name === primaryName);
  const { pairs, claimed } = pairItems(newItems, candidates, valueOf);

  // For paired items, rewrite the primary's value (preserving its header and
  // group) AND rewrite the X-ABLabel sibling sharing that group.
  const labelByGroup = new Map<string, RawRecord>();
  for (const r of records) {
    if (r.name === "x-ablabel" && r.group) labelByGroup.set(r.group, r);
  }

  const removedGroups = new Set<string>();
  for (const r of records) {
    if (candidates.includes(r) && !claimed.has(r) && r.group) {
      removedGroups.add(r.group);
    }
  }

  const pairByOrigin = new Map<RawRecord, T>();
  for (const { item, origin } of pairs) {
    if (origin) pairByOrigin.set(origin, item);
  }

  const result: RawRecord[] = [];
  for (const r of records) {
    if (candidates.includes(r)) {
      const item = pairByOrigin.get(r);
      if (item !== undefined) {
        // Rewrite primary value, preserving header (group + params).
        result.push(
          withRebuiltPhysical(r, r.header, escapeText(valueOf(item))),
        );
      }
      // else: removed
      continue;
    }
    if (r.name === "x-ablabel" && r.group) {
      if (removedGroups.has(r.group)) continue; // sibling of removed primary
      // If the sibling belongs to a paired primary, rewrite its value to the
      // new label; otherwise preserve.
      const primaryOrigin = candidates.find(
        (c) => c.group === r.group && claimed.has(c),
      );
      if (primaryOrigin) {
        const item = pairByOrigin.get(primaryOrigin)!;
        result.push(
          withRebuiltPhysical(r, r.header, escapeText(labelOf(item))),
        );
        continue;
      }
    }
    result.push(r);
  }

  // Append fresh primary + label sibling for unmatched new items.
  const fresh: RawRecord[] = [];
  for (const { item, origin } of pairs) {
    if (origin) continue;
    const group = allocGroup();
    fresh.push(
      buildFreshRecord({
        name: primaryName.toUpperCase(),
        rawValue: escapeText(valueOf(item)),
        group,
      }),
    );
    fresh.push(
      buildFreshRecord({
        name: "X-ABLabel",
        rawValue: escapeText(labelOf(item)),
        group,
      }),
    );
  }
  return insertBeforeEnd(result, fresh);
}

/**
 * Merge custom (unmodeled) properties. Items keyed by (name, group); items in
 * the new array upsert their match by ref / by key, items present in the
 * original but absent from the new array are NOT removed unless the user
 * explicitly passes `custom: []` (semantics matching the array-field mergers).
 *
 * The merger preserves header/params on update, just rewriting the value.
 */
function mergeCustom(
  records: RawRecord[],
  custom: ContactField[] | undefined,
): RawRecord[] {
  if (custom === undefined) return records;
  const candidates = records.filter(
    (r) => !!r.rawName && !MODELED_NAMES.has(r.name),
  );

  // Pair by (name, group) — the historical contract. Origin ref takes priority
  // (matched by physical bytes so it survives the patcher's internal re-parse).
  const claimed = new Set<RawRecord>();
  const pairs: Array<{ item: ContactField; origin?: RawRecord }> = [];
  for (const item of custom) {
    const ref = readOrigin(item);
    if (ref) {
      const refKey = recordKey(ref);
      const refMatch = candidates.find(
        (c) => !claimed.has(c) && recordKey(c) === refKey,
      );
      if (refMatch) {
        claimed.add(refMatch);
        pairs.push({ item, origin: refMatch });
        continue;
      }
    }
    const key = customKey(item.key, item.group ?? null);
    const match = candidates.find(
      (r) => !claimed.has(r) && customKey(r.rawName, r.rawGroup) === key,
    );
    if (match) {
      claimed.add(match);
      pairs.push({ item, origin: match });
    } else {
      pairs.push({ item });
    }
  }

  // Custom fields: unclaimed candidates are PRESERVED (not removed) — the
  // contract is upsert-by-key, not full replacement.
  const pairByOrigin = new Map<RawRecord, ContactField>();
  for (const { item, origin } of pairs) {
    if (origin) pairByOrigin.set(origin, item);
  }
  const result: RawRecord[] = [];
  for (const r of records) {
    const matched = pairByOrigin.get(r);
    if (matched !== undefined) {
      // Update value; preserve header (and thus all params/group).
      const newRawValue = escapeText(matched.value);
      const needsTypeUpdate = (matched.type ?? null) !== (r.type ?? null);
      const header = needsTypeUpdate
        ? replaceTypeInHeader(r.header, matched.type)
        : r.header;
      result.push(withRebuiltPhysical(r, header, newRawValue));
    } else {
      result.push(r);
    }
  }
  const fresh: RawRecord[] = [];
  for (const { item, origin } of pairs) {
    if (origin || !item.key) continue;
    fresh.push(
      buildFreshRecord({
        name: item.key,
        rawValue: escapeText(item.value),
        ...(item.type !== undefined ? { type: item.type } : {}),
        ...(item.group !== undefined ? { group: item.group } : {}),
      }),
    );
  }
  return insertBeforeEnd(result, fresh);
}

function customKey(name: string, group: string | null): string {
  return `${name.toLowerCase()} ${(group ?? "").toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Group allocator
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

// ---------------------------------------------------------------------------
// Public patcher
// ---------------------------------------------------------------------------

/**
 * Apply the contact's set fields onto the raw vCard, rewriting only the
 * records the contact explicitly changes and preserving every other byte. The
 * patcher does NOT do wholesale replacement; it pairs new items with origin
 * records (by `RECORD_ORIGIN` back-ref first, then by value), rewrites those
 * origin records in place (preserving every param, group prefix, and grouped
 * label sibling not in `replaceNames`-style sets), removes unmatched origins
 * (and only their X-ABLabel siblings), and appends fresh records for new
 * items just before `END:VCARD`.
 *
 * Net effect: any vCard property or parameter the structured `Contact` model
 * does not surface is preserved by default, forever, even when the model
 * never grows to cover it.
 */
export function patchRawVCard(raw: string, contact: Contact): string {
  const records = parseRecords(raw);
  // The patcher rewrites a single vCard; refuse vCard collections so two
  // BEGIN/END blocks cannot be flattened into one structurally invalid card.
  let beginCount = 0;
  for (const record of records) {
    if (record.name === "begin") beginCount++;
  }
  if (beginCount > 1) {
    throw new SyntaxError(
      "Cannot patch a vCard collection: input contains multiple BEGIN:VCARD records.",
    );
  }
  const allocGroup = makeGroupAllocator(records);

  // Singletons (deterministic ordering: header / identity first, content last).
  let next = records;
  next = mergeTextSingleton(next, "uid", contact.uid);
  next = mergeTextSingleton(next, "fn", contact.fullName);
  next = mergeName(next, contact);
  next = mergeTextSingleton(next, "nickname", contact.nickname);
  next = mergeOrg(next, contact);
  next = mergeTextSingleton(next, "title", contact.title);
  next = mergeCategories(next, contact.categories);
  next = mergeTextSingleton(next, "bday", contact.birthday);
  next = mergeTextSingleton(next, "note", contact.note);
  next = mergePhoto(next, contact.photo);

  // Arrays.
  next = mergePhones(next, contact.phones);
  next = mergeEmails(next, contact.emails);
  next = mergeUrls(next, contact.urls);
  next = mergeAddresses(next, contact.addresses);
  next = mergeIMPP(next, contact.instantMessages);
  next = mergeSocialProfiles(next, contact.socialProfiles);
  next = mergeLabeledPair<ContactRelatedName>(
    next,
    contact.relatedNames,
    "x-abrelatednames",
    (r) => r.name,
    (r) => r.label,
    allocGroup,
  );
  next = mergeLabeledPair<ContactDate>(
    next,
    contact.dates,
    "x-abdate",
    (d) => d.date,
    (d) => d.label,
    allocGroup,
  );
  next = mergeCustom(next, contact.custom);

  return next.flatMap((r) => r.physical).join(CRLF);
}
