import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Parsing options shared by transformer, source, and read-destination modes.
 *
 * The attribute / text / CDATA naming keys (`attributeNamePrefix`,
 * `textNodeName`, `cdataPropName`, `ignoreAttributes`) are also honoured when
 * building XML in destination mode, so a parse then build round-trip preserves
 * structure when the same options are used on both ends.
 */
export interface XmlParseOptions {
  /**
   * Drop XML attributes from the parsed output (and omit them when building).
   * Routecraft defaults this to `false` so attributes survive a round-trip;
   * fast-xml-parser's own default is `true`.
   * Default: false
   */
  ignoreAttributes?: boolean;

  /**
   * Prefix applied to attribute keys in the parsed object (and recognised when
   * building). Default: '@_'
   */
  attributeNamePrefix?: string;

  /**
   * Property name used for the text content of a node that also has attributes
   * or children. Default: '#text'
   */
  textNodeName?: string;

  /**
   * Property name used for CDATA sections. When omitted, CDATA content is
   * merged into the node text. Default: undefined
   */
  cdataPropName?: string;

  /**
   * Coerce attribute string values to number / boolean. Default: false
   */
  parseAttributeValue?: boolean;

  /**
   * Coerce tag text values to number / boolean. Default: true
   */
  parseTagValue?: boolean;

  /**
   * Trim whitespace around text values. Default: true
   */
  trimValues?: boolean;

  /**
   * Strip namespace prefixes from tag and attribute names (e.g. `ns:tag` ->
   * `tag`). Default: false
   */
  removeNSPrefix?: boolean;
}

/**
 * Formatting options used when building XML in destination write mode.
 */
export interface XmlBuildOptions {
  /**
   * Pretty-print the output with line breaks and indentation. Default: false
   */
  format?: boolean;

  /**
   * Indentation unit used when `format` is true. Default: '  ' (two spaces)
   */
  indentBy?: string;

  /**
   * Collapse empty nodes to self-closing tags (`<a/>` instead of `<a></a>`).
   * Default: false
   */
  suppressEmptyNode?: boolean;
}

/**
 * Transformer-mode options (no `path`): parse an XML string already in the body.
 */
export interface XmlTransformerOptions<
  T = unknown,
  R = unknown,
> extends XmlParseOptions {
  /**
   * Pluck the XML string from the body. If omitted: body is used when it's a
   * string, or body.body when body is an object (e.g. after http()).
   */
  from?: (body: T) => string;

  /**
   * Where to put the parsed object. If omitted, the result replaces the entire
   * body. Use e.g. (body, parsed) => ({ ...body, parsed }) to write to a
   * sub-field.
   */
  to?: (body: T, parsed: XmlData) => R;
}

/**
 * Source / Destination mode options (with `path`).
 *
 * Note: XML has no `append` mode. Appending serialized fragments to an XML
 * document produces multiple root elements and an invalid document, so the
 * adapter deliberately omits it. Read the file, mutate the parsed object, and
 * write it back instead.
 */
export interface XmlFileOptions extends XmlParseOptions, XmlBuildOptions {
  /**
   * File path for source / destination mode. A function form (resolved per
   * exchange) is only valid for destinations.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Create parent directories if they don't exist (write mode only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * File operation mode.
   * - 'read': Read + parse the XML file. Works as a source (`.from`) and,
   *   because read mode returns the parsed object, mid-route via `.enrich()` /
   *   `.to()`. As a destination, parse failures throw (the route boundary
   *   surfaces them as `exchange:failed`); the `onParseError` lifecycle controls
   *   apply to source mode only.
   * - 'write': Build the body object into an XML document and write / overwrite
   *   the file (destination mode).
   * - 'delete': Delete the XML file (destination mode). Idempotent: an already-
   *   absent path is a no-op. The body is unchanged. Supports dynamic paths.
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "delete";

  /**
   * How to handle a parse failure on the file content (source mode only).
   *
   * - `'fail'` (default): `exchange:failed` fires; the route's `.error()`
   *   handler can recover.
   * - `'abort'`: `exchange:failed` fires, then the source dies
   *   (`context:error`).
   * - `'drop'`: `exchange:dropped` fires with `reason: "parse-failed"`.
   *
   * See `OnParseError` for full semantics.
   *
   * @default "fail"
   */
  onParseError?: OnParseError;
}

export type XmlOptions<T = unknown, R = unknown> =
  | XmlTransformerOptions<T, R>
  | XmlFileOptions;

/** A parsed XML document represented as a plain object. */
export type XmlData = Record<string, unknown>;
