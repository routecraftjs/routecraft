import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { JsonFileOptions } from "./types.ts";
import { file } from "../file/index.ts";

/**
 * JsonDestinationAdapter implements the Destination (send) role for JSON
 * files.
 *
 * `send` is strictly void: it stringifies the exchange body and writes it
 * (overwrite by default, `append: true` to append, `delete: true` to remove
 * the file). Reading lives on the fetch role (JsonEnricherAdapter).
 */
export class JsonDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.json.file";

  constructor(private readonly options: JsonFileOptions) {}

  send: CallableDestination<unknown> = async (exchange) => {
    const {
      space,
      indent,
      replacer,
      path: filePath,
      encoding,
      createDirs,
      append = false,
      delete: remove = false,
    } = this.options;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Delete behavior: delegate to the file adapter (no stringify). Idempotent.
    if (remove) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    const formatting = indent ?? space ?? 0;

    let jsonString: string;
    try {
      const result = JSON.stringify(
        exchange.body,
        replacer as never,
        formatting,
      );
      if (result === undefined) {
        throw new Error(
          "value is not JSON-serializable (top-level undefined, function, or symbol)",
        );
      }
      jsonString = result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`json adapter: failed to stringify JSON: ${message}`);
    }

    const stringExchange: Exchange = {
      ...exchange,
      body: jsonString,
    };

    await file({
      path: resolvedPath,
      append,
      ...(encoding !== undefined ? { encoding } : {}),
      ...(createDirs !== undefined ? { createDirs } : {}),
    }).send(stringExchange);
  };
}
