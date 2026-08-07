import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { selectsFileRole } from "../shared/file-role-guards.ts";
import type {
  XmlData,
  XmlFileOptions,
  XmlOptions,
  XmlTransformerOptions,
} from "./types.ts";
import { XmlSourceAdapter } from "./source.ts";
import { XmlDestinationAdapter } from "./destination.ts";
import { XmlEnricherAdapter } from "./enricher.ts";
import { XmlTransformerAdapter } from "./transformer.ts";

/**
 * Combined XML file adapter type: all three roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches). The parsed object is typed `T` (default `XmlData`);
 * pass it explicitly (`xml<MyDoc>(...)`) for a typed body.
 *
 * @template T - Parsed object type (caller-asserted)
 */
export type XmlAdapter<T = XmlData> = Source<T> &
  Destination<unknown> &
  Enricher<unknown, T> & { readonly adapterId: string };

/**
 * Creates an XML adapter.
 *
 * **Transformer role** (no `path` option): parses an XML string already in
 * the body.
 *
 * **File roles** (`path` present); the POSITION in the route selects the role:
 * - **`.from(xml({ path }))`** reads + parses the file and emits the object.
 * - **`.to(xml({ path }))`** builds the body object into an XML document and
 *   writes it (`delete: true` removes the file instead). The body flows
 *   through unchanged.
 * - **`.enrich(xml({ path }))`** reads + parses mid-route; the object
 *   replaces the body (pass an aggregator such as `only()` to merge instead).
 *
 * Requires `fast-xml-parser` to be installed as an optional peer dependency.
 *
 * @param options - Transformer options (no `path`) or file options
 * @returns A Transformer (no path) or the combined file adapter (path)
 *
 * @example
 * ```typescript
 * // Parse an XML string already in the body (transformer role)
 * .transform(xml({ from: (b) => b.body }))
 *
 * // Read an XML file as a source
 * .from(xml({ path: './data.xml' }))
 *
 * // Read mid-route (the parsed object replaces the body)
 * .enrich(xml({ path: './data.xml' }), only((doc) => doc, 'doc'))
 *
 * // Write to an XML file (pretty-printed)
 * .to(xml({ path: './output.xml', format: true }))
 *
 * // Delete an XML file (idempotent)
 * .to(xml({ path: (ex) => ex.body.processedPath, delete: true }))
 * ```
 */
export function xml<T = XmlData>(options: XmlFileOptions): XmlAdapter<T>;
export function xml<T = unknown, R = unknown>(
  options?: XmlTransformerOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
export function xml<T = unknown, R = unknown>(
  options: XmlOptions<T, R> = {},
): (Transformer<T, R> & { readonly adapterId: string }) | XmlAdapter {
  const args = factoryArgs(options);

  // Transformer role: no path means parse an XML string already in the body.
  if (!selectsFileRole("xml", options)) {
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
  const enricher = new XmlEnricherAdapter(fileOptions);
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.xml",
      subscribe: source.subscribe,
      send: destination.send,
      fetch: enricher.fetch,
    },
    xml,
    args,
  ) as XmlAdapter;
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
