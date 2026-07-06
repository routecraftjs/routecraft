import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type {
  XmlData,
  XmlFileOptions,
  XmlOptions,
  XmlTransformerOptions,
} from "./types.ts";
import { XmlSourceAdapter } from "./source.ts";
import { XmlDestinationAdapter } from "./destination.ts";
import { XmlTransformerAdapter } from "./transformer.ts";

/** Combined XML adapter type exposing both Source and Destination interfaces. */
export type XmlAdapter = Source<XmlData> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Read-mode XML adapter. As a destination its `send` reads + parses the file
 * and returns the parsed object, so it works mid-route via `.enrich()` /
 * `.to()` (like an HTTP GET). It remains usable as a `.from()` source. The
 * parsed object is typed `T` (default `XmlData`); pass it explicitly
 * (`xml<MyDoc>(...)`) for a typed merge.
 */
export type XmlReadAdapter<T = XmlData> = Source<T> &
  Destination<unknown, T> & { readonly adapterId: string };

/**
 * Creates an XML transformer that parses an XML string already in the body.
 *
 * Requires `fast-xml-parser` to be installed as an optional peer dependency.
 *
 * @param options - Transformer options (`from`, `to`, parsing options); no `path`
 * @returns A Transformer
 */
export function xml<T = unknown, R = unknown>(
  options?: XmlTransformerOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
/**
 * Creates a read-mode XML adapter (source, and destination that returns the
 * parsed object).
 *
 * @param options - XML file options with mode: 'read'
 * @returns A Source + read Destination adapter
 */
export function xml<T = XmlData>(
  options: XmlFileOptions & { mode: "read" },
): XmlReadAdapter<T>;
/**
 * Creates an XML adapter for reading or writing XML files.
 *
 * As a **source** (.from):
 * - Reads an XML file and parses it into a plain object
 *
 * As a **destination** (.to):
 * - Builds the object body into an XML document and writes it
 * - Can create parent directories automatically
 * - `mode: 'read'` returns the parsed object mid-route; `mode: 'delete'` removes
 *   the file (idempotent) and passes the body through
 *
 * Requires `fast-xml-parser` to be installed as an optional peer dependency.
 *
 * @param options - XML path, parsing / formatting options
 * @returns Combined Source and Destination adapter
 *
 * @example
 * ```typescript
 * // Parse an XML string already in the body (transformer mode)
 * .transform(xml({ from: (b) => b.body }))
 *
 * // Read an XML file as a source
 * .from(xml({ path: './data.xml' }))
 *
 * // Read mid-route (destination that returns the parsed object)
 * .enrich(xml({ path: './data.xml', mode: 'read' }), only((doc) => doc, 'doc'))
 *
 * // Write to an XML file (pretty-printed)
 * .to(xml({ path: './output.xml', format: true }))
 *
 * // Delete an XML file (idempotent)
 * .to(xml({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
 * ```
 */
export function xml(options: XmlFileOptions): XmlAdapter;
export function xml<T = unknown, R = unknown>(
  options: XmlOptions<T, R> = {},
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | XmlReadAdapter
  | XmlAdapter {
  const args = factoryArgs(options);

  // Transformer mode: no path means parse an XML string already in the body.
  if (!("path" in options) || options.path === undefined) {
    const transformer = new XmlTransformerAdapter<T, R>(
      options as XmlTransformerOptions<T, R>,
    );
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.xml",
        transform: transformer.transform.bind(transformer),
      },
      xml,
      args,
    ) as Transformer<T, R> & { readonly adapterId: string };
  }

  const fileOptions = options as XmlFileOptions;
  const source = new XmlSourceAdapter(fileOptions);
  const destination = new XmlDestinationAdapter(fileOptions);
  const tagged = tagAdapter(
    {
      adapterId: "routecraft.adapter.xml",
      subscribe: source.subscribe,
      send: destination.send,
    },
    xml,
    args,
  );
  // In read mode `send` resolves to the parsed object; narrow accordingly so
  // `.enrich()` / `.to()` infer the object. Otherwise `send` is a write (void).
  // The runtime object is identical; only its declared type differs.
  if (fileOptions.mode === "read") {
    return tagged as unknown as XmlReadAdapter;
  }
  return tagged as unknown as XmlAdapter;
}

// Re-export types
export type {
  XmlOptions,
  XmlTransformerOptions,
  XmlFileOptions,
  XmlParseOptions,
  XmlBuildOptions,
  XmlData,
} from "./types.ts";
