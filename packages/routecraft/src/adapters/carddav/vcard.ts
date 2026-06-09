/**
 * vCard document: a plain-data body plus an optional {@link VCard} wrapper.
 *
 * The exchange body is plain, serialization-safe data ({@link VCardBody}): a
 * version string and an ordered list of {@link VCardPropertyData}. It survives
 * `structuredClone`, `JSON.stringify`, queues, and `tap` with nothing lost,
 * because it is just data.
 *
 * For ergonomics, wrap a body in a {@link VCard} (`VCard.wrap(body)`,
 * `VCard.create()`, `VCard.parse(string)`). The wrapper reads and edits the
 * underlying data in place and exposes `.data` to get the plain body back. The
 * wrapper is a transient view, never the body itself, so the body stays plain.
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
  type PropertySpec,
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

/**
 * A single vCard property as plain data. `value` is the escaped wire value (the
 * lossless source of truth); use {@link VCardProperty.value} on a wrapper for
 * the decoded text, or {@link VCardProperty.components} for structured values.
 */
export interface VCardPropertyData {
  /** Property name as written (e.g. `"TEL"`, `"X-SOCIALPROFILE"`). */
  name: string;
  /** Group prefix (e.g. `"item1"`), if any. */
  group?: string;
  /** Parameters, in order, captured verbatim. */
  params: VCardParam[];
  /** Escaped wire value (post-unfold), exactly as it appears after the colon. */
  value: string;
}

/** A vCard document as plain data. This is the exchange body. */
export interface VCardBody {
  /** vCard version (default `"3.0"`). */
  version: string;
  /** The ordered property list. */
  properties: VCardPropertyData[];
}

/** Options when adding a property. */
export interface VCardPropertyOptions {
  /** Group prefix (e.g. `"item1"`) for label-grouped properties. */
  group?: string;
  /** Parameters to attach (e.g. `[{ name: "type", value: "home" }]`). */
  params?: VCardParam[];
}

/**
 * A transient view over one {@link VCardPropertyData}. Reads and writes go
 * straight through to the underlying plain object, so edits are reflected in the
 * body. `value` is decoded text; `raw` is the escaped wire form.
 */
export class VCardProperty {
  constructor(private readonly data: VCardPropertyData) {}

  /** Property name as written. */
  get name(): string {
    return this.data.name;
  }
  /** Group prefix, or undefined. */
  get group(): string | undefined {
    return this.data.group;
  }
  /** Parameters, in order. */
  get params(): VCardParam[] {
    return this.data.params;
  }
  /** Decoded text value (RFC 6350 escapes resolved). */
  get value(): string {
    return unescapeText(this.data.value);
  }
  set value(v: string) {
    this.data.value = escapeText(v);
  }
  /** The escaped wire value, exactly as it appears after the colon. */
  get raw(): string {
    return this.data.value;
  }

  /** Decoded components of a structured value, split on unescaped `separator`. */
  components(separator = ";"): string[] {
    return splitOnUnescaped(this.data.value, separator);
  }

  /** Set a structured value from decoded components (each escaped, then joined). */
  setComponents(parts: string[], separator = ";"): this {
    this.data.value = parts.map(escapeText).join(separator);
    return this;
  }

  /** First value of the named parameter (case-insensitive), if present. */
  param(name: string): string | undefined {
    return firstParam(this.data.params, name);
  }
}

/**
 * An ergonomic wrapper around a {@link VCardBody}. Construct one with
 * {@link VCard.wrap}, {@link VCard.create}, or {@link VCard.parse}; read it with
 * `get`/`first`/`text`; edit it with `set`/`add`/`remove`; and read `.data` to
 * get the plain body to put back on the exchange.
 */
export class VCard {
  /** The underlying plain-data body. */
  readonly data: VCardBody;

  private constructor(data: VCardBody) {
    this.data = data;
  }

  /** Wrap an existing plain body (edits write through to it). */
  static wrap(body: VCardBody): VCard {
    return new VCard(body);
  }

  /** Create a wrapper over a fresh, empty body. */
  static create(version: string = DEFAULT_VERSION): VCard {
    return new VCard({ version, properties: [] });
  }

  /**
   * Parse a single vCard string into a wrapper. `.data` is the plain body.
   *
   * @throws If the input is not a single `BEGIN:VCARD ... END:VCARD` block.
   */
  static parse(raw: string): VCard {
    const records = parseRecords(raw);
    let beginCount = 0;
    let hasEnd = false;
    let version = DEFAULT_VERSION;
    const properties: VCardPropertyData[] = [];

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
      properties.push({
        name: record.rawName,
        ...(record.rawGroup !== null ? { group: record.rawGroup } : {}),
        params: record.params,
        value: record.rawValue,
      });
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
    return new VCard({ version, properties });
  }

  /** Serialize a plain body to wire form (`BEGIN:VCARD` ... `END:VCARD`). */
  static serialize(body: VCardBody): string {
    const lines = ["BEGIN:VCARD", `VERSION:${body.version}`];
    for (const p of body.properties) {
      const spec: PropertySpec = {
        name: p.name,
        params: p.params,
        value: p.value,
      };
      if (p.group !== undefined) spec.group = p.group;
      lines.push(emitProperty(spec));
    }
    lines.push("END:VCARD");
    return lines.join(CRLF);
  }

  // -- reads -----------------------------------------------------------------

  /** vCard version. */
  get version(): string {
    return this.data.version;
  }
  set version(v: string) {
    this.data.version = v;
  }

  /** Property views, in order. */
  get properties(): VCardProperty[] {
    return this.data.properties.map((p) => new VCardProperty(p));
  }

  /** All properties with the given name (case-insensitive). */
  get(name: string): VCardProperty[] {
    const lower = name.toLowerCase();
    return this.data.properties
      .filter((p) => p.name.toLowerCase() === lower)
      .map((p) => new VCardProperty(p));
  }

  /** The first property with the given name (case-insensitive), if any. */
  first(name: string): VCardProperty | undefined {
    const lower = name.toLowerCase();
    const data = this.data.properties.find(
      (p) => p.name.toLowerCase() === lower,
    );
    return data ? new VCardProperty(data) : undefined;
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

  /** Append a property (a decoded value, escaped on the way in). */
  add(name: string, value: string, options: VCardPropertyOptions = {}): this {
    assertValidName(name);
    if (options.group !== undefined) assertValidName(options.group, "group");
    for (const param of options.params ?? []) {
      assertValidName(param.name, "parameter name");
    }
    this.data.properties.push({
      name,
      ...(options.group !== undefined ? { group: options.group } : {}),
      params: options.params ?? [],
      value: escapeText(value),
    });
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
    this.data.properties = this.data.properties.filter(
      (p) => p.name.toLowerCase() !== lower,
    );
    return this;
  }

  /** Serialize this card's data to wire form. */
  toString(): string {
    return VCard.serialize(this.data);
  }

  /** A deep, independent copy (wrapper over cloned data). */
  clone(): VCard {
    return new VCard(structuredClone(this.data));
  }

  /** Plain representation for `JSON.stringify` / logging (the body). */
  toJSON(): VCardBody {
    return this.data;
  }
}

/** Parse a vCard string into a {@link VCard} wrapper. */
export function parseVCard(raw: string): VCard {
  return VCard.parse(raw);
}
