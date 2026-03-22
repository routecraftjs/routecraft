import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";

/** File-related options extracted from HtmlOptions. */
interface HtmlFileFields {
  path?: string | ((exchange: Exchange) => string);
  mode?: "read" | "write" | "append";
  encoding?: BufferEncoding;
  createDirs?: boolean;
}

/**
 * HtmlDestinationAdapter writes HTML strings to files.
 * Only available when path option is provided.
 */
export class HtmlDestinationAdapter implements Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly fileAdapter: ReturnType<typeof file> | null;
  private readonly fileBaseOpts: Omit<FileOptions, "path">;
  private readonly pathOption: string | ((exchange: Exchange) => string);

  constructor(options: HtmlFileFields) {
    if (!options.path) {
      throw new Error(
        "html adapter: destination mode requires path option to be provided",
      );
    }
    this.pathOption = options.path;
    this.fileBaseOpts = {};
    if (options.mode !== undefined) this.fileBaseOpts.mode = options.mode;
    if (options.encoding !== undefined)
      this.fileBaseOpts.encoding = options.encoding;
    if (options.createDirs !== undefined)
      this.fileBaseOpts.createDirs = options.createDirs;

    // For static paths, create file adapter once; for dynamic paths, defer
    if (typeof options.path === "string") {
      this.fileAdapter = file({ path: options.path, ...this.fileBaseOpts });
    } else {
      this.fileAdapter = null;
    }
  }

  send: CallableDestination<unknown, void> = async (exchange) => {
    // Resolve dynamic path from the ORIGINAL exchange before mutating body
    const resolvedPath =
      typeof this.pathOption === "function"
        ? this.pathOption(exchange)
        : this.pathOption;

    // Extract HTML string from exchange body
    let htmlContent: string;
    if (typeof exchange.body === "string") {
      htmlContent = exchange.body;
    } else if (
      exchange.body &&
      typeof exchange.body === "object" &&
      "body" in exchange.body &&
      typeof (exchange.body as { body: unknown }).body === "string"
    ) {
      htmlContent = (exchange.body as { body: string }).body;
    } else {
      throw new Error(
        "html adapter: destination mode requires exchange.body to be a string or an object with a string body property",
      );
    }

    // Create modified exchange with HTML content as body
    const modifiedExchange: Exchange = {
      ...exchange,
      body: htmlContent,
    };

    // Use pre-built adapter for static paths, or create one for dynamic paths
    const adapter =
      this.fileAdapter ?? file({ path: resolvedPath, ...this.fileBaseOpts });

    await adapter.send(modifiedExchange);
  };
}
