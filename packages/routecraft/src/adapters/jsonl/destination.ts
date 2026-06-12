import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { JsonlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { parseJsonl } from "./shared.ts";

/**
 * JsonlDestinationAdapter handles JSON Lines file I/O as a destination.
 *
 * - `write` / `append` (default): stringify each body to a single line. Array
 *   bodies write one line per element.
 * - `read`: read the file, parse every line, and return the array, so the
 *   adapter works mid-route via `.enrich()` / `.to()` (like an HTTP GET). Parse
 *   failures throw; the route boundary surfaces them as `exchange:failed`.
 * - `delete`: delete the file and pass the body through unchanged. Idempotent.
 */
export class JsonlDestinationAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlFileOptions) {}

  send: CallableDestination<unknown, unknown> = async (exchange) => {
    const {
      path: filePath,
      encoding = "utf-8",
      mode = "append",
      createDirs = false,
      replacer,
      reviver,
    } = this.options;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Read mode: read the file via the file adapter, then parse and return.
    if (mode === "read") {
      const readAdapter = file({ path: resolvedPath, mode: "read", encoding });
      const content = await readAdapter.send(exchange);
      return parseJsonl(content, reviver);
    }

    // Delete mode: delegate to the file adapter (no stringify). Idempotent.
    if (mode === "delete") {
      const deleteAdapter = file({ path: resolvedPath, mode: "delete" });
      return deleteAdapter.send(exchange);
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
      mode,
      createDirs,
    });

    await fileAdapter.send({ ...exchange, body: output });

    return undefined;
  };
}
