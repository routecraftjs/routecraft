import * as fsp from "node:fs/promises";
import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { FileOptions } from "./types.ts";
import { throwFileError } from "../shared/fs-errors.ts";

/**
 * FileEnricherAdapter implements the Enricher (fetch) role for file I/O:
 * `fetch` reads the resolved path and returns its content as a string, so
 * `.enrich(file({ path }))` pulls a file into the route mid-flow. Dynamic
 * (function) paths are supported because the exchange is available when the
 * read runs.
 */
export class FileEnricherAdapter implements Enricher<unknown, string> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {}

  /** Fetch implementation: read the resolved path and return the content. */
  fetch: CallableEnricher<unknown, string> = async (exchange) => {
    const { path: filePath, encoding = "utf-8" } = this.options;
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;
    return fsp
      .readFile(resolvedPath, { encoding })
      .catch((err) => throwFileError("file", resolvedPath, err));
  };
}
