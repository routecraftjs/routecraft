/**
 * Low-level vCard lexer and emitter primitives.
 *
 * This module does two things and nothing else:
 *
 *  - parse raw vCard text into a flat list of {@link RawRecord}s (one per
 *    logical line), preserving every parameter verbatim so the codec can read
 *    a contact losslessly; and
 *  - emit a single property line back to RFC 6350 wire form (escaping, folding,
 *    parameter quoting).
 *
 * There is deliberately no diff/merge/patch machinery here. The codec reads a
 * card into a complete {@link Contact} (anything it does not model lands in
 * `custom`), and writes by serializing the whole contact. A write replaces the
 * card; it does not surgically edit it. That is what keeps this small and what
 * makes "read then save loses nothing" a property of the parser alone, not of a
 * reconstruction engine.
 *
 * @experimental
 */

const CRLF = "\r\n";

/** A single vCard parameter, captured verbatim (name lowercased, value dequoted). */
export interface VCardParam {
  /** Parameter name, lowercased (e.g. `type`, `x-service-type`). */
  name: string;
  /** Parameter value with surrounding quotes removed, original casing kept. */
  value: string;
}

/** One logical vCard line (folding undone), parsed into its parts. */
export interface RawRecord {
  /** Lowercased property name without the group prefix (e.g. `tel`). */
  name: string;
  /** Lowercased group prefix (e.g. `item1`), or null. */
  group: string | null;
  /** Original property name as written (e.g. `X-SOCIALPROFILE`). */
  rawName: string;
  /** Original group as written (e.g. `item1`), or null. */
  rawGroup: string | null;
  /** Every parameter, in wire order, captured verbatim. */
  params: VCardParam[];
  /** Unescaped value (RFC 6350 text escapes decoded, line folding undone). */
  value: string;
  /** Raw (still-escaped) value, for component-accurate structured splitting. */
  rawValue: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split raw vCard text into records, unfolding continuation lines. */
export function parseRecords(raw: string): RawRecord[] {
  const physical = raw.split(/\r\n|\r|\n/);
  const records: RawRecord[] = [];
  let current: string[] | null = null;

  const flush = (): void => {
    if (current) records.push(toRecord(current));
    current = null;
  };

  for (const line of physical) {
    // Blank lines between records (some exporters emit them around BEGIN:VCARD)
    // are not header lines and must not seed phantom records.
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

/** Strip surrounding double quotes from a parameter value (RFC 6350 3.3). */
function dequoteParam(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function toRecord(lines: string[]): RawRecord {
  // Undo folding to recover the logical line.
  const logical = lines
    .map((line, index) => (index === 0 ? line : line.slice(1)))
    .join("");

  // The header/value boundary is the first colon not inside a quoted param
  // value (e.g. `KEY;TYPE="a:b":value`).
  const colon = indexOfUnquoted(logical, ":");
  const header = colon >= 0 ? logical.slice(0, colon) : logical;
  const value = colon >= 0 ? logical.slice(colon + 1) : "";

  const segments = splitUnquoted(header);
  const nameSegment = segments[0] ?? "";
  const dot = nameSegment.indexOf(".");
  const rawGroup = dot >= 0 ? nameSegment.slice(0, dot) : null;
  const rawName = dot >= 0 ? nameSegment.slice(dot + 1) : nameSegment;

  const params: VCardParam[] = [];
  for (const segment of segments.slice(1)) {
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    const name = (eq >= 0 ? segment.slice(0, eq) : segment).toLowerCase();
    const paramValue = dequoteParam(eq >= 0 ? segment.slice(eq + 1) : "");
    params.push({ name, value: paramValue });
  }

  return {
    name: rawName.toLowerCase(),
    group: rawGroup ? rawGroup.toLowerCase() : null,
    rawName,
    rawGroup,
    params,
    value: unescapeText(value),
    rawValue: value,
  };
}

/** First value of the named parameter, if present. */
export function firstParam(
  record: RawRecord,
  name: string,
): string | undefined {
  return record.params.find((p) => p.name === name)?.value;
}

/** The ergonomic primary TYPE: first `type` value that is not `pref`. */
export function primaryType(record: RawRecord): string | undefined {
  for (const param of record.params) {
    if (param.name !== "type") continue;
    for (const candidate of param.value.split(",")) {
      const lowered = candidate.trim().toLowerCase();
      if (lowered && lowered !== "pref") return lowered;
    }
  }
  return undefined;
}

/**
 * Split a vCard value on `separator` characters that are not preceded by a
 * backslash, then unescape each segment. Explicit escape tracking handles `\,`/
 * `\;` (escaped separator) and `\\,`/`\\;` (escaped backslash + separator)
 * correctly, which a naive `split()` over the unescaped value does not.
 */
export function splitOnUnescaped(
  rawValue: string,
  separator: string,
): string[] {
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

// ---------------------------------------------------------------------------
// Apple X-ABLabel wrappers
// ---------------------------------------------------------------------------

/**
 * Apple wraps its built-in labels in `_$!<Label>!$_`. The set below is keyed by
 * lowercase label so {@link encodeLabel} can re-wrap a decoded built-in label
 * on write (a custom label like "Best friend" is emitted bare). Keeping the
 * canonical casing here is what makes a built-in label round-trip.
 */
const APPLE_STANDARD_LABELS = new Map<string, string>(
  [
    "Work",
    "Home",
    "Other",
    "Mobile",
    "Main",
    "HomeFax",
    "WorkFax",
    "OtherFax",
    "Pager",
    "HomePage",
    "Anniversary",
    "Spouse",
    "Child",
    "Parent",
    "Mother",
    "Father",
    "Brother",
    "Sister",
    "Friend",
    "Partner",
    "Assistant",
    "Manager",
  ].map((label) => [label.toLowerCase(), label]),
);

/** Decode Apple's `_$!<Label>!$_` wrapper to a plain label. */
export function decodeLabel(label: string): string {
  const match = /^_\$!<(.+)>!\$_$/.exec(label);
  return match ? (match[1] as string) : label;
}

/** Re-wrap a built-in Apple label; emit a custom label unchanged. */
export function encodeLabel(label: string): string {
  const canonical = APPLE_STANDARD_LABELS.get(label.toLowerCase());
  return canonical ? `_$!<${canonical}>!$_` : label;
}

// ---------------------------------------------------------------------------
// Emit / escape primitives
// ---------------------------------------------------------------------------

/**
 * Escape a value per RFC 6350 (backslash, comma, semicolon, newline). Used for
 * free-text values and for individual components of structured values (`N`,
 * `ADR`), where the literal `;` separators are added by the caller afterwards.
 * `\r`, `\r\n` and `\n` all collapse to the `\n` escape so a stray line ending
 * in user-supplied text cannot break the on-wire grammar.
 */
export function escapeText(value: string): string {
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
 * Quote a parameter value per RFC 6350 3.3 when it contains characters that
 * would break the header grammar. Embedded double-quotes and newlines are not
 * representable in a quoted param, so they are stripped.
 */
function escapeParamValue(value: string): string {
  const cleaned = value.replace(/["\r\n]/g, "");
  return /[;:,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/**
 * Fold a logical line to <=75 octets per physical line using CRLF + single
 * space continuations (RFC 6350 3.2). Counts UTF-8 byte length and never splits
 * inside a code point, so multibyte values (accents, CJK, emoji) fold safely.
 * The leading space of a continuation counts toward its 75 octets.
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let isContinuation = false;
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

/** A property to emit: group + name + params + an already-escaped value. */
export interface PropertySpec {
  name: string;
  group?: string | null;
  params?: VCardParam[];
  /** Value bytes as they should appear after the colon (already escaped). */
  value: string;
}

/** Emit one property as folded wire text (no trailing CRLF). */
export function emitProperty(spec: PropertySpec): string {
  const prefix = spec.group ? `${spec.group}.` : "";
  let header = `${prefix}${spec.name}`;
  for (const param of spec.params ?? []) {
    header += `;${param.name}=${escapeParamValue(param.value)}`;
  }
  return foldLine(`${header}:${spec.value}`);
}

// ---------------------------------------------------------------------------
// Group allocation
// ---------------------------------------------------------------------------

/**
 * Allocate fresh `itemN` group prefixes that do not collide with any group
 * already present (passed in so preserved `custom` groups are respected).
 */
export function makeGroupAllocator(
  existingGroups: Iterable<string | null | undefined>,
): () => string {
  let max = 0;
  for (const group of existingGroups) {
    const match = group ? /^item(\d+)$/.exec(group) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  let next = max;
  return () => `item${++next}`;
}
