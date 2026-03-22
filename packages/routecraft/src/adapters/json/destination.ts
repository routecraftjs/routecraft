import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { JsonFileOptions } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file, type FileAdapter } from "../file/index.ts";

/**
 * JsonDestinationAdapter stringifies and writes JSON to files.
 */
export class JsonDestinationAdapter implements Destination<unknown, void> {
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
      this.fileAdapter = file(fileOptions);
    } else {
      this.fileAdapter = null;
    }
  }

  send: CallableDestination<unknown, void> = async (exchange) => {
    const { space, indent, replacer, path: filePath } = this.options;
    const formatting = indent ?? space ?? 0;

    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    let jsonString: string;
    try {
      jsonString = JSON.stringify(exchange.body, replacer as never, formatting);
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
