import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonFileOptions } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";

/**
 * JsonSourceAdapter reads and parses JSON files.
 */
export class JsonSourceAdapter implements Source<unknown> {
  readonly adapterId = "routecraft.adapter.json.file";
  private readonly fileAdapter;

  constructor(private readonly options: JsonFileOptions) {
    if (typeof options.path !== "string") {
      throw new Error(
        "json adapter: dynamic paths (path as function) are only supported for destination mode",
      );
    }
    // Build options object, only including defined properties to satisfy exactOptionalPropertyTypes
    const fileOptions: FileOptions = { path: options.path };
    if (options.mode !== undefined) fileOptions.mode = options.mode;
    if (options.encoding !== undefined) fileOptions.encoding = options.encoding;
    if (options.createDirs !== undefined)
      fileOptions.createDirs = options.createDirs;
    this.fileAdapter = file(fileOptions);
  }

  subscribe: CallableSource<unknown> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    return this.fileAdapter.subscribe(
      context,
      async (content: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content, this.options.reviver as never);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`json adapter: failed to parse JSON: ${message}`);
        }
        return await handler(parsed);
      },
      abortController,
      onReady,
    );
  };
}
