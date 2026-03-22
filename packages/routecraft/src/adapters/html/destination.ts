import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";

/**
 * HtmlDestinationAdapter writes HTML strings to files.
 * Only available when path option is provided.
 */
export class HtmlDestinationAdapter<
  T = unknown,
  R = HtmlResult,
> implements Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly fileAdapter;

  constructor(options: HtmlOptions<T, R>) {
    if (!options.path) {
      throw new Error(
        "html adapter: destination mode requires path option to be provided",
      );
    }
    const fileOpts: FileOptions = { path: options.path };
    if (options.mode !== undefined) fileOpts.mode = options.mode;
    if (options.encoding !== undefined) fileOpts.encoding = options.encoding;
    if (options.createDirs !== undefined)
      fileOpts.createDirs = options.createDirs;
    this.fileAdapter = file(fileOpts);
  }

  send: CallableDestination<unknown, void> = async (exchange) => {
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

    // Use file adapter to write HTML
    await this.fileAdapter.send(modifiedExchange);
  };
}
