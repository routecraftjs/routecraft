import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { JsonlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";

/**
 * JsonlDestinationAdapter implements the Destination (send) role for JSON
 * Lines files.
 *
 * `send` is strictly void: it stringifies the body to JSONL (array bodies
 * write one line per element) and writes it (overwrite by default,
 * `append: true` to append, `delete: true` to remove the file). Reading
 * lives on the fetch role (JsonlEnricherAdapter).
 */
export class JsonlDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlFileOptions) {}

  send: CallableDestination<unknown> = async (exchange) => {
    const {
      path: filePath,
      encoding = "utf-8",
      append = false,
      delete: remove = false,
      createDirs = false,
      replacer,
    } = this.options;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Delete behavior: delegate to the file adapter (no stringify). Idempotent.
    if (remove) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    const stringify = (value: unknown): string =>
      Array.isArray(replacer)
        ? JSON.stringify(value, replacer)
        : JSON.stringify(
            value,
            replacer as ((key: string, value: unknown) => unknown) | undefined,
          );

    let output: string;
    if (Array.isArray(exchange.body)) {
      output = exchange.body.map((item) => stringify(item)).join("\n") + "\n";
    } else {
      output = stringify(exchange.body) + "\n";
    }

    const fileAdapter = file({
      path: resolvedPath,
      encoding,
      append,
      createDirs,
    });

    await fileAdapter.send({ ...exchange, body: output });
  };
}
