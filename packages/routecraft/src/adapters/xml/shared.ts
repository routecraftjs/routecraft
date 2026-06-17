import { loadOptionalPeer } from "../shared/optional-peer.ts";
import type { XmlBuildOptions, XmlData, XmlParseOptions } from "./types.ts";

// Memoise the loaded fast-xml-parser module so high-volume xml() calls do not
// re-pay the dynamic-import lookup or re-allocate the loadOptionalPeer
// closures. The promise is shared across all callers, so the import happens at
// most once per process. A rejected promise is intentionally cached too: a
// genuinely missing peer cannot appear mid-process, so retrying would only
// reproduce the same RC5017 with the same install hint.
let fxpPromise: Promise<typeof import("fast-xml-parser")> | null = null;

/**
 * Load fast-xml-parser as an optional peer dependency. Missing-package
 * failures surface as RC5017 with an install hint.
 *
 * @internal Not exported from the package public API.
 */
function getFastXmlParser(): Promise<typeof import("fast-xml-parser")> {
  fxpPromise ??= loadOptionalPeer(() => import("fast-xml-parser"), {
    adapterName: "xml",
    packageName: "fast-xml-parser",
  });
  return fxpPromise;
}

/**
 * Validate and parse an XML string into a plain object.
 *
 * The content is validated first so malformed XML throws a descriptive error
 * (fast-xml-parser's parser is otherwise lenient and would silently produce a
 * partial object). Source / read-destination modes surface the throw as an
 * RC5016 parse failure via the synthetic parse step.
 *
 * @internal Not exported from the package public API.
 */
export async function parseXml(
  content: string,
  options: XmlParseOptions,
): Promise<XmlData> {
  const { XMLParser, XMLValidator } = await getFastXmlParser();

  const validation = XMLValidator.validate(content);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw new Error(
      `xml adapter: parse error at line ${line}, column ${col}: ${msg}`,
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: options.ignoreAttributes ?? false,
    attributeNamePrefix: options.attributeNamePrefix ?? "@_",
    textNodeName: options.textNodeName ?? "#text",
    parseAttributeValue: options.parseAttributeValue ?? false,
    parseTagValue: options.parseTagValue ?? true,
    trimValues: options.trimValues ?? true,
    removeNSPrefix: options.removeNSPrefix ?? false,
    ...(options.cdataPropName !== undefined
      ? { cdataPropName: options.cdataPropName }
      : {}),
  });

  return parser.parse(content) as XmlData;
}

/**
 * Build an XML string from a plain object.
 *
 * @internal Not exported from the package public API.
 */
export async function buildXml(
  value: unknown,
  options: XmlParseOptions & XmlBuildOptions,
): Promise<string> {
  const { XMLBuilder } = await getFastXmlParser();

  const builder = new XMLBuilder({
    ignoreAttributes: options.ignoreAttributes ?? false,
    attributeNamePrefix: options.attributeNamePrefix ?? "@_",
    textNodeName: options.textNodeName ?? "#text",
    format: options.format ?? false,
    indentBy: options.indentBy ?? "  ",
    suppressEmptyNode: options.suppressEmptyNode ?? false,
    ...(options.cdataPropName !== undefined
      ? { cdataPropName: options.cdataPropName }
      : {}),
  });

  return builder.build(value) as string;
}
