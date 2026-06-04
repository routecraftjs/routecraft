import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { JsonFileOptions } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file, type FileAdapter } from "../file/index.ts";

/**
 * JsonDestinationAdapter handles JSON file I/O as a destination.
 *
 * - `write` / `append` (default): stringify the exchange body and write it.
 * - `read`: read the file, `JSON.parse` it, and return the parsed value, so the
 *   adapter works mid-route via `.enrich()` / `.to()` (like an HTTP GET). Parse
 *   failures throw; the route boundary surfaces them as `exchange:failed`,
 *   which `.error()` can recover. The `onParseError` lifecycle controls
 *   (`'abort'` / `'drop'`) remain source-mode only.
 */
export class JsonDestinationAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.json.file";
  private readonly fileAdapter: FileAdapter | null;

  constructor(private readonly options: JsonFileOptions) {
    // For static paths, create file adapter immediately
    if (typeof options.path === "string") {
      const fileOptions: FileOptions = { path: options.path };
      if (options.mode !== undefined) fileOptions.mode = options.mode;
      if (options.encoding !== undefined)
        fileOptions.encoding = options.encoding;
      if (options.createDirs !== undefined)
        fileOptions.createDirs = options.createDirs;
      this.fileAdapter = file(fileOptions) as FileAdapter;
    } else {
      this.fileAdapter = null;
    }
  }

  send: CallableDestination<unknown, unknown> = async (exchange) => {
    const { space, indent, replacer, path: filePath } = this.options;

    // Read mode: read the file via the file adapter, then parse and return.
    if (this.options.mode === "read") {
      const resolvedReadPath =
        typeof filePath === "function" ? filePath(exchange) : filePath;
      let readAdapter = this.fileAdapter;
      if (!readAdapter) {
        const fileOptions: FileOptions = {
          path: resolvedReadPath,
          mode: "read",
        };
        if (this.options.encoding !== undefined)
          fileOptions.encoding = this.options.encoding;
        readAdapter = file(fileOptions) as FileAdapter;
      }
      // The file adapter's `send` is typed `void` on FileAdapter, but in read
      // mode it resolves to the file content. Narrow through `unknown`.
      const content = (await readAdapter.send(exchange)) as unknown as string;
      try {
        return JSON.parse(content, this.options.reviver as never) as unknown;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `json adapter: failed to parse JSON from ${resolvedReadPath}: ${message}`,
        );
      }
    }

    const formatting = indent ?? space ?? 0;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

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

    let adapter = this.fileAdapter;
    if (!adapter) {
      const fileOptions: FileOptions = { path: resolvedPath };
      if (this.options.mode !== undefined) fileOptions.mode = this.options.mode;
      if (this.options.encoding !== undefined)
        fileOptions.encoding = this.options.encoding;
      if (this.options.createDirs !== undefined)
        fileOptions.createDirs = this.options.createDirs;
      adapter = file(fileOptions);
    }

    return adapter.send(stringExchange);
  };
}
