import type { Source, CallableSource } from "../../operations/from.ts";
import type { DirectoryEntry, DirectoryOptions } from "./types.ts";
import { scanDirectory } from "./scan.ts";

/**
 * DirectorySourceAdapter implements the Source interface for scanning a
 * directory. It lists the directory once and emits the result either as a
 * single exchange carrying the full {@link DirectoryEntry}`[]` listing (default)
 * or, when `chunked`, one exchange per entry.
 *
 * Filtering is intentionally not built in: list the entries and let the route
 * decide. In chunked mode, filter on the body (`.filter((ex) => ex.body.ext
 * === ".json")`), then read content with the file adapter (`.enrich(file({
 * path: (ex) => ex.body.path }))`). This keeps "find files" and "decide which
 * ones" as separate, composable steps.
 *
 * The scan itself (entry resolution, symlink handling, deterministic sort
 * order) lives in {@link scanDirectory}, shared with the enricher role so
 * every role lists the same tree identically.
 */
export class DirectorySourceAdapter implements Source<
  DirectoryEntry | DirectoryEntry[]
> {
  readonly adapterId = "routecraft.adapter.directory";

  constructor(private readonly options: DirectoryOptions) {}

  /**
   * Source implementation: scan the directory and emit the listing. Reads the
   * directory once (this is a finite source). When `chunked`, emits one
   * exchange per entry; otherwise a single exchange with the `DirectoryEntry[]`.
   */
  subscribe: CallableSource<DirectoryEntry | DirectoryEntry[]> = async (
    sub,
  ) => {
    if (sub.signal.aborted) return;

    const {
      path: dir,
      recursive = false,
      includeDirs = false,
      chunked = false,
    } = this.options;

    if (typeof dir !== "string") {
      throw new Error(
        "directory adapter: the source role requires a static string path (dynamic paths are only supported by the enricher role, which runs per exchange)",
      );
    }

    // Ready means "wired and able to produce", so signal before scanning
    // rather than after every entry has been emitted.
    sub.ready();

    const entries = await scanDirectory(
      dir,
      { recursive, includeDirs },
      { signal: sub.signal, logger: sub.context.logger },
    );
    if (sub.signal.aborted) return;

    if (chunked) {
      for (const entry of entries) {
        if (sub.signal.aborted) return;
        try {
          await sub.emit({ message: entry });
        } catch {
          // Pipeline failure for one entry, not a scan error: the route
          // boundary already emitted exchange:failed; keep emitting the rest
          // (matching the file/csv/jsonl chunked semantics).
          if (sub.signal.aborted) return;
          sub.context.logger.debug(
            { path: entry.path, adapter: "directory" },
            "directory adapter: pipeline failed for entry; continuing",
          );
        }
      }
    } else if (!sub.signal.aborted) {
      // Default: a single exchange carrying the whole listing, mirroring the
      // non-chunked csv/jsonl shape. An empty directory still emits one
      // exchange with an empty array.
      try {
        await sub.emit({ message: entries });
      } catch {
        // Exchange error already logged by the route pipeline; mirror the
        // chunked branch's debug line so the adapter is not silent when
        // its only exchange fails.
        sub.context.logger.debug(
          { path: dir, adapter: "directory" },
          "directory adapter: pipeline failed for listing exchange",
        );
      }
    }

    // Finite source: signal completion so a single-source route can finish.
    sub.complete();
  };
}
