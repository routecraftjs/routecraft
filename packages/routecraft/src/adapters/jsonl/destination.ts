import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { JsonlDestinationOptions } from "./types.ts";
import { file } from "../file/index.ts";

/**
 * JsonlDestinationAdapter writes exchanges as JSON Lines.
 * Each body is stringified to a single line. Array bodies write one line per element.
 * Default mode is append.
 *
 * @beta
 */
export class JsonlDestinationAdapter implements Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlDestinationOptions) {}

  send: CallableDestination<unknown, void> = async (exchange) => {
    const {
      path: filePath,
      encoding = "utf-8",
      mode = "append",
      createDirs = false,
      replacer,
    } = this.options;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

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
