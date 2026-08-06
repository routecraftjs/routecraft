import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { file } from "../file/index.ts";
import { getHtml } from "./shared.ts";

/**
 * HtmlDestinationAdapter implements the Destination (send) role for HTML
 * files.
 *
 * `send` is strictly void: it writes the HTML string from the body to the
 * resolved path (overwrite by default, `append: true` to append,
 * `delete: true` to remove the file). Reading + extraction lives on the
 * fetch role (HtmlEnricherAdapter).
 */
export class HtmlDestinationAdapter<
  T = unknown,
  R = HtmlResult,
> implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly pathOption: string | ((exchange: Exchange) => string);

  constructor(private readonly options: HtmlOptions<T, R>) {
    if (!options.path) {
      throw new Error(
        "html adapter: the send role requires the path option to be provided",
      );
    }
    this.pathOption = options.path;
  }

  send: CallableDestination<unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.pathOption === "function"
        ? this.pathOption(exchange)
        : this.pathOption;

    // Delete behavior: delegate to the file adapter (no write). Idempotent.
    if (this.options.delete) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    // Write / append: pull the HTML string from the body and write it.
    const htmlContent = getHtml(exchange.body, undefined);

    const adapter = file({
      path: resolvedPath,
      append: this.options.append ?? false,
      ...(this.options.encoding !== undefined
        ? { encoding: this.options.encoding }
        : {}),
      ...(this.options.createDirs !== undefined
        ? { createDirs: this.options.createDirs }
        : {}),
    });

    await adapter.send({ ...exchange, body: htmlContent });
  };
}
