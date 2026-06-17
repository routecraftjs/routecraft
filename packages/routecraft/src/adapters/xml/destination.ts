import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { XmlData, XmlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { buildXml, parseXml } from "./shared.ts";

/**
 * XmlDestinationAdapter handles XML file I/O as a destination.
 *
 * - `write` (default): build the exchange body (a plain object) into an XML
 *   document and write it.
 * - `read`: read the file, parse it, and return the parsed object, so the
 *   adapter works mid-route via `.enrich()` / `.to()` (like an HTTP GET). Parse
 *   failures throw; the route boundary surfaces them as `exchange:failed`. The
 *   `onParseError` lifecycle controls (`'abort'` / `'drop'`) remain source-only.
 * - `delete`: delete the file and pass the body through unchanged. Idempotent.
 */
export class XmlDestinationAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.xml";

  constructor(private readonly options: XmlFileOptions) {}

  send: CallableDestination<unknown, unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Read mode: read the file via the file adapter, then parse and return.
    if (this.options.mode === "read") {
      const readAdapter = file({
        path: resolvedPath,
        mode: "read",
        encoding: this.options.encoding || "utf-8",
      });
      const content = await readAdapter.send(exchange);
      return (await parseXml(content, this.options)) as XmlData;
    }

    // Delete mode: delegate to the file adapter (no build). Idempotent.
    if (this.options.mode === "delete") {
      const deleteAdapter = file({ path: resolvedPath, mode: "delete" });
      return deleteAdapter.send(exchange);
    }

    // Write mode: the body must be a single object describing the XML
    // document. Arrays are rejected: they have no single root element, so the
    // builder would emit numerically-named sibling tags (e.g. <0>...</0>) and
    // an invalid document rather than failing.
    if (
      exchange.body === null ||
      typeof exchange.body !== "object" ||
      Array.isArray(exchange.body)
    ) {
      throw new Error(
        "xml adapter: write mode requires the exchange body to be a single object representing the XML document (a single root element); arrays produce multiple root elements and an invalid document",
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
      mode: "write",
      createDirs: this.options.createDirs || false,
    });

    await fileAdapter.send({
      ...exchange,
      body: xmlString,
    });

    return undefined;
  };
}
