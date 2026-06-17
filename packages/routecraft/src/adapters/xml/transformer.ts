import type { Transformer } from "../../operations/transform.ts";
import type { XmlData, XmlTransformerOptions } from "./types.ts";
import { parseXml } from "./shared.ts";
import { getBodyText } from "../shared/body-text.ts";

/**
 * XmlTransformerAdapter parses an XML string already in the exchange body into
 * a plain object. It is the decode counterpart to the file source: use it when
 * the XML text arrived in-memory (e.g. an HTTP response) rather than from disk.
 *
 * Requires `fast-xml-parser` to be installed as an optional peer dependency.
 */
export class XmlTransformerAdapter<
  T = unknown,
  R = unknown,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.xml";

  constructor(private readonly options: XmlTransformerOptions<T, R>) {}

  async transform(body: T): Promise<R> {
    const text = getBodyText(body, this.options.from, "xml");
    const parsed: XmlData = await parseXml(text, this.options);
    const to = this.options.to;
    if (to) return to(body, parsed);
    return parsed as unknown as R;
  }
}
