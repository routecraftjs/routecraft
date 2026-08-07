import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { DirectoryEntry, DirectoryOptions } from "./types.ts";
import { getExchangeContext } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import { scanDirectory } from "./scan.ts";

/**
 * DirectoryEnricherAdapter implements the Enricher (fetch) role for
 * directories: `fetch` scans the resolved path and returns the sorted
 * {@link DirectoryEntry}`[]` listing, so `.enrich(directory({ path }))` pulls
 * a listing into the route mid-flow (and `.to(directory({ path }))` replaces
 * the body with it, since directory has no `send`). A listing is a read, so
 * it belongs in the pull-in role alongside a file read.
 *
 * This is what makes the adapter usable inside a `direct()` capability, where
 * there is no `.from()` slot to hang the listing on. Dynamic (function) paths
 * are supported because the exchange is available when the scan runs; the
 * source role keeps its static-string requirement.
 *
 * `recursive`, `includeDirs`, symlink handling, and the deterministic sort
 * order are identical to the source: both delegate to {@link scanDirectory}.
 */
export class DirectoryEnricherAdapter implements Enricher<
  unknown,
  DirectoryEntry[]
> {
  readonly adapterId = "routecraft.adapter.directory";

  constructor(private readonly options: DirectoryOptions) {}

  /**
   * Fetch implementation: scan the resolved path and return the sorted
   * listing. A missing or unreadable directory throws (`directory not
   * found`, `not a directory`, `permission denied`), matching the source's
   * error mapping.
   */
  fetch: CallableEnricher<unknown, DirectoryEntry[]> = async (
    exchange,
    ctx,
  ) => {
    const { path: dir, recursive = false, includeDirs = false } = this.options;

    // Resolve the path (static or dynamic).
    const resolvedDir = typeof dir === "function" ? dir(exchange) : dir;

    const entries = await scanDirectory(
      resolvedDir,
      { recursive, includeDirs },
      {
        // An enclosing .timeout() abort stops the stat workers early.
        signal: ctx?.signal,
        logger: getExchangeContext(exchange)?.logger,
      },
    );

    // An aborted scan returns whatever it had collected, which is a partial
    // listing indistinguishable from a complete one. That is fine for the
    // source (abort just stops emission) but not here: the fetched value
    // becomes the route's body. Throw instead, so a truncated listing can
    // never be mistaken for the real contents of the directory. Correctness
    // must not depend on the caller discarding the value.
    if (ctx?.signal?.aborted) {
      // RC5011 is what the timeout wrapper throws when its own deadline
      // fires, so classifying this the same way keeps `.error()` handlers
      // and retry policy treating a cut-short listing as the timeout it is,
      // rather than as an opaque adapter failure.
      throw rcError("RC5011", undefined, {
        message: `directory adapter: listing aborted before completion: ${resolvedDir}`,
        suggestion:
          "Increase the enclosing .timeout() so the scan can finish, or narrow the scan (drop recursive, or point at a smaller directory)",
      });
    }

    return entries;
  };
}
