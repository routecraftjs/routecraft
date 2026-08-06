import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { XmlData, XmlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { parseXml } from "./shared.ts";

/**
 * XmlEnricherAdapter implements the Enricher (fetch) role for XML files:
 * `fetch` reads the resolved path, parses it, and returns the parsed object,
 * so `.enrich(xml({ path }))` pulls an XML file into the route mid-flow.
 * Parse failures throw (the route boundary surfaces them as
 * `exchange:failed`); the `onParseError` lifecycle controls apply to the
 * source role only.
 *
 * @template T - Parsed object type (caller-asserted, e.g. `xml<MyDoc>(...)`)
 */
export class XmlEnricherAdapter<T = XmlData> implements Enricher<unknown, T> {
  readonly adapterId = "routecraft.adapter.xml";

  constructor(private readonly options: XmlFileOptions) {}

  /** Fetch implementation: read the resolved path and return the parsed object. */
  fetch: CallableEnricher<unknown, T> = async (exchange, ctx) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;
    const content = await file({
      path: resolvedPath,
      encoding: this.options.encoding || "utf-8",
    }).fetch(exchange, ctx);
    return (await parseXml(content, this.options)) as T;
  };
}
