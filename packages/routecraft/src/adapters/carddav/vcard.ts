/**
 * vCard document model.
 *
 * A {@link VCard} is the faithful, lossless representation of a vCard: an ordered
 * list of {@link VCardProperty} entries. There is no typed `Contact` projection.
 * You read and write the properties directly (like working with parsed JSON from
 * an HTTP endpoint), and bring your own typed shape in a `.transform()` if you
 * want one. Because the document IS the protocol, a read-then-write loses
 * nothing it was not explicitly told to change.
 *
 * @experimental
 */

import {
  emitProperty,
  escapeText,
  firstParam,
  parseRecords,
  splitOnUnescaped,
  unescapeText,
  type VCardParam,
} from "./vcard-raw.ts";

const CRLF = "\r\n";
const DEFAULT_VERSION = "3.0";

/** Valid characters for a vCard property name, group, or parameter name. */
const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** Throw on a name/group/param that could break the header grammar on emit. */
function assertValidName(value: string, kind = "property name"): void {
  if (!NAME_PATTERN.test(value)) {
    throw new SyntaxError(
      `Invalid vCard ${kind} ${JSON.stringify(value)}: only letters, digits, and hyphens are allowed.`,
    );
  }
}

/** Options when constructing or adding a property. */
export interface VCardPropertyOptions {
  /** Group prefix (e.g. `"item1"`) for label-grouped properties. */
  group?: string;
  /** Parameters to attach (e.g. `[{ name: "type", value: "home" }]`). */
  params?: VCardParam[];
}

/**
 * One vCard property (e.g. `TEL;TYPE=home:+1...`). The decoded text is exposed
 * via {@link VCardProperty.value}; the escaped wire form is kept internally so a
 * round-trip is byte-faithful for anything you do not change. For structured
 * properties (`N`, `ADR`, `ORG`) use {@link VCardProperty.components}.
 */
export class VCardProperty {
  /** Property name as written (e.g. `"TEL"`, `"X-SOCIALPROFILE"`). */
  name: string;
  /** Group prefix (e.g. `"item1"`), or undefined. */
  group: string | undefined;
  /** Parameters, in order. */
  params: VCardParam[];
  /** Escaped value bytes (post-unfold), the lossless source of truth. */
  #raw: string;

  /**
   * @param value By default a decoded value that is escaped on the way in. Pass
   *   `options.raw = true` (used by the parser) to supply already-escaped bytes.
   */
  constructor(
    name: string,
    value: string,
    options: VCardPropertyOptions & { raw?: boolean } = {},
  ) {
    // Caller-supplied names/groups/params are validated so they cannot inject a
    // colon, semicolon, or newline into the header and forge or split a
    // property on write. The parser (`raw: true`) trusts the lexer's output.
    if (!options.raw) {
      assertValidName(name);
      if (options.group !== undefined) assertValidName(options.group, "group");
      for (const param of options.params ?? []) {
        assertValidName(param.name, "parameter name");
      }
    }
    this.name = name;
    this.group = options.group;
    this.params = options.params ?? [];
    this.#raw = options.raw ? value : escapeText(value);
  }

  /** Decoded text value (RFC 6350 escapes resolved). */
  get value(): string {
    return unescapeText(this.#raw);
  }
  set value(v: string) {
    this.#raw = escapeText(v);
  }

  /** The escaped wire value, exactly as it appears after the colon. */
  get raw(): string {
    return this.#raw;
  }

  /** Decoded components of a structured value, split on unescaped `separator`. */
  components(separator = ";"): string[] {
    return splitOnUnescaped(this.#raw, separator);
  }

  /** Set a structured value from decoded components (each escaped, then joined). */
  setComponents(parts: string[], separator = ";"): this {
    this.#raw = parts.map(escapeText).join(separator);
    return this;
  }

  /** First value of the named parameter (case-insensitive), if present. */
  param(name: string): string | undefined {
    return firstParam(this.params, name);
  }

  /** A deep copy of this property. */
  clone(): VCardProperty {
    return new VCardProperty(this.name, this.#raw, {
      raw: true,
      ...(this.group !== undefined ? { group: this.group } : {}),
      params: this.params.map((p) => ({ ...p })),
    });
  }

  /**
   * Plain representation for `JSON.stringify` / logging. The value lives in a
   * private field, so without this a logged property would show no value; the
   * decoded value is exposed here for readability.
   */
  toJSON(): {
    name: string;
    group?: string;
    params: VCardParam[];
    value: string;
  } {
    return {
      name: this.name,
      ...(this.group !== undefined ? { group: this.group } : {}),
      params: this.params,
      value: this.value,
    };
  }
}

/**
 * A vCard document: the property list plus DAV identity (`url`/`etag`) carried
 * alongside it on read. `BEGIN`/`END`/`VERSION` are managed by the document and
 * are not part of {@link VCard.properties}.
 */
export class VCard {
  /** vCard version emitted by {@link VCard.toString} (default `"3.0"`). */
  version: string;
  /** DAV object URL (set on read; used to target updates/deletes). */
  url: string | undefined;
  /** DAV ETag (set on read; sent as `If-Match` on update/delete). */
  etag: string | undefined;
  /** The content properties, in order. */
  properties: VCardProperty[];

  constructor(
    properties: VCardProperty[] = [],
    version: string = DEFAULT_VERSION,
  ) {
    this.properties = properties;
    this.version = version;
  }

  /**
   * Parse a single vCard string into a {@link VCard}.
   *
   * @throws If the input is not a single `BEGIN:VCARD ... END:VCARD` block.
   */
  static parse(raw: string): VCard {
    const records = parseRecords(raw);
    let beginCount = 0;
    let hasEnd = false;
    let version = DEFAULT_VERSION;
    const properties: VCardProperty[] = [];

    for (const record of records) {
      if (
        record.name === "begin" &&
        !record.group &&
        record.value.toUpperCase() === "VCARD"
      ) {
        beginCount++;
        continue;
      }
      if (
        record.name === "end" &&
        !record.group &&
        record.value.toUpperCase() === "VCARD"
      ) {
        hasEnd = true;
        continue;
      }
      if (record.name === "version" && !record.group) {
        version = record.value;
        continue;
      }
      properties.push(
        new VCardProperty(record.rawName, record.rawValue, {
          raw: true,
          ...(record.rawGroup !== null ? { group: record.rawGroup } : {}),
          params: record.params,
        }),
      );
    }

    if (beginCount === 0 || !hasEnd) {
      throw new SyntaxError(
        "vCard payload did not contain a BEGIN:VCARD/END:VCARD block",
      );
    }
    if (beginCount > 1) {
      throw new SyntaxError(
        "vCard payload contains a vCard collection; VCard.parse accepts a single card",
      );
    }
    return new VCard(properties, version);
  }

  /** Serialize back to wire form (`BEGIN:VCARD` ... `END:VCARD`). */
  toString(): string {
    const lines = ["BEGIN:VCARD", `VERSION:${this.version}`];
    for (const p of this.properties) {
      lines.push(
        emitProperty({
          name: p.name,
          group: p.group ?? null,
          params: p.params,
          value: p.raw,
        }),
      );
    }
    lines.push("END:VCARD");
    return lines.join(CRLF);
  }

  // -- reads -----------------------------------------------------------------

  /** All properties with the given name (case-insensitive). */
  get(name: string): VCardProperty[] {
    const lower = name.toLowerCase();
    return this.properties.filter((p) => p.name.toLowerCase() === lower);
  }

  /** The first property with the given name (case-insensitive), if any. */
  first(name: string): VCardProperty | undefined {
    const lower = name.toLowerCase();
    return this.properties.find((p) => p.name.toLowerCase() === lower);
  }

  /** Decoded value of the first property with the given name. */
  text(name: string): string | undefined {
    return this.first(name)?.value;
  }

  /** Decoded values of every property with the given name. */
  values(name: string): string[] {
    return this.get(name).map((p) => p.value);
  }

  /** The vCard `UID`, if present. */
  get uid(): string | undefined {
    return this.text("UID");
  }
  set uid(value: string | undefined) {
    if (value === undefined) this.remove("UID");
    else this.set("UID", value);
  }

  // -- writes ----------------------------------------------------------------

  /**
   * Append a property. To append an already-built {@link VCardProperty} (e.g. a
   * clone), push it onto {@link VCard.properties} directly.
   */
  add(name: string, value: string, options?: VCardPropertyOptions): this {
    this.properties.push(new VCardProperty(name, value, options ?? {}));
    return this;
  }

  /** Replace every property of `name` with a single one (case-insensitive). */
  set(name: string, value: string, options?: VCardPropertyOptions): this {
    this.remove(name);
    return this.add(name, value, options);
  }

  /** Remove every property with the given name (case-insensitive). */
  remove(name: string): this {
    const lower = name.toLowerCase();
    this.properties = this.properties.filter(
      (p) => p.name.toLowerCase() !== lower,
    );
    return this;
  }

  /** A deep copy, including url/etag/version. */
  clone(): VCard {
    const copy = new VCard(
      this.properties.map((p) => p.clone()),
      this.version,
    );
    copy.url = this.url;
    copy.etag = this.etag;
    return copy;
  }

  /** Plain representation for `JSON.stringify` / logging. */
  toJSON(): {
    version: string;
    url?: string;
    etag?: string;
    properties: VCardProperty[];
  } {
    return {
      version: this.version,
      ...(this.url !== undefined ? { url: this.url } : {}),
      ...(this.etag !== undefined ? { etag: this.etag } : {}),
      properties: this.properties,
    };
  }
}

/** Parse a vCard string into a {@link VCard} document. */
export function parseVCard(raw: string): VCard {
  return VCard.parse(raw);
}
