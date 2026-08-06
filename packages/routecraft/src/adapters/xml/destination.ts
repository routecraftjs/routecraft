import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { XmlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { buildXml } from "./shared.ts";

/**
 * XmlDestinationAdapter implements the Destination (send) role for XML files.
 *
 * `send` is strictly void: it builds the exchange body (a plain object) into
 * an XML document and writes it (overwrite; `delete: true` removes the file
 * instead). Reading lives on the fetch role (XmlEnricherAdapter).
 */
export class XmlDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.xml";

  constructor(private readonly options: XmlFileOptions) {}

  send: CallableDestination<unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Delete behavior: delegate to the file adapter (no build). Idempotent.
    if (this.options.delete) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    // Write behavior: the body must be a single object describing the XML
    // document. Arrays are rejected: they have no single root element, so the
    // builder would emit numerically-named sibling tags (e.g. <0>...</0>) and
    // an invalid document rather than failing.
    if (
      exchange.body === null ||
      typeof exchange.body !== "object" ||
      Array.isArray(exchange.body)
    ) {
      throw new Error(
        "xml adapter: the send role requires the exchange body to be a single object representing the XML document (a single root element); arrays produce multiple root elements and an invalid document",
      );
    }

    // An XML document has exactly one root element. The builder emits a
    // top-level tag for every object key, so a multi-key body like
    // { a: {...}, b: {...} } would serialise to sibling roots (<a/><b/>) and
    // an invalid document. Keys starting with "?" are the XML declaration and
    // processing instructions (e.g. "?xml"), which the builder emits before
    // the root, so they are not counted as roots.
    const rootKeys = Object.keys(exchange.body).filter(
      (key) => !key.startsWith("?"),
    );
    if (rootKeys.length !== 1) {
      throw new Error(
        `xml adapter: the send role requires the exchange body to have exactly one root element, but found ${rootKeys.length} (${rootKeys.join(", ") || "none"}); wrap your data in a single root object`,
      );
    }

    let xmlString: string;
    try {
      xmlString = await buildXml(exchange.body, this.options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`xml adapter: failed to build XML: ${message}`);
    }

    const fileAdapter = file({
      path: resolvedPath,
      encoding: this.options.encoding || "utf-8",
      createDirs: this.options.createDirs || false,
    });

    await fileAdapter.send({
      ...exchange,
      body: xmlString,
    });
  };
}
