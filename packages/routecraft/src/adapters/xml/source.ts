import type { Source, CallableSource } from "../../operations/from.ts";
import type { XmlData, XmlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { parseXml } from "./shared.ts";
import { DEFAULT_ON_PARSE_ERROR, isParseError } from "../shared/parse.ts";

/**
 * XmlSourceAdapter reads XML files and parses them via fast-xml-parser.
 *
 * Emits a single exchange whose body is the parsed object. Parsing is deferred
 * to the route's pipeline by passing a `parse` callback to `emit`: the runtime
 * applies it as a synthetic first step so a malformed XML file becomes an
 * observable pipeline event:
 *
 * | `onParseError` | Lifecycle on bad XML                                          |
 * |----------------|---------------------------------------------------------------|
 * | `'fail'` (default) | `exchange:failed` (or `error:caught` if `.error()` recovers) |
 * | `'abort'`      | `exchange:failed`, then source rejects and `context:error` fires |
 * | `'drop'`       | `exchange:dropped` with `reason: "parse-failed"`              |
 */
export class XmlSourceAdapter implements Source<XmlData> {
  readonly adapterId = "routecraft.adapter.xml";

  constructor(private readonly options: XmlFileOptions) {}

  subscribe: CallableSource<XmlData> = async (sub) => {
    const onParseError = this.options.onParseError ?? DEFAULT_ON_PARSE_ERROR;

    const filePath = this.options.path;
    if (typeof filePath !== "string") {
      throw new Error(
        "xml adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    const fileAdapter = file({
      path: filePath,
      encoding: this.options.encoding || "utf-8",
    });

    const parseFn = (raw: unknown): Promise<XmlData> =>
      parseXml(raw as string, this.options);

    // Delegate to the file source with a derived subscription whose emit
    // attaches the XML parse to the raw file content.
    await fileAdapter.subscribe({
      ...sub,
      emit: async (msg) => {
        // The raw file content is a string pre-parse; the synthetic parse
        // step narrows it to XmlData (the standard pre-parse type caveat).
        const promise = sub.emit({
          message: msg.message as unknown as XmlData,
          ...(msg.headers ? { headers: msg.headers } : {}),
          parse: parseFn,
          parseFailureMode: onParseError,
        });
        // 'abort' is parse-specific: only RC5016 should tear down the source.
        // A downstream destination error must NOT propagate as an abort signal
        // even when onParseError === 'abort'. Every other failure is
        // debug-logged and swallowed (matching json/csv) so the source keeps
        // reading.
        return await promise.catch((err: unknown) => {
          if (onParseError === "abort" && isParseError(err)) throw err;
          sub.context.logger.debug(
            { err, path: filePath, adapter: "xml" },
            "xml adapter: pipeline failed for file; continuing",
          );
          return undefined as never;
        });
      },
    });
  };
}
