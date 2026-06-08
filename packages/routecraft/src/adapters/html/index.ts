import type { Source, CallableSource } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Transformer } from "../../operations/transform.ts";
import type { Exchange } from "../../exchange.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { HtmlTransformerAdapter } from "./transformer.ts";
import { HtmlSourceAdapter } from "./source.ts";
import { HtmlDestinationAdapter } from "./destination.ts";

/** Combined HTML adapter type exposing Transformer, Source, and Destination interfaces. */
export type HtmlAdapter<T = unknown, R = HtmlResult> = Transformer<T, R> &
  Source<HtmlResult> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Read-mode HTML adapter. As a destination its `send` reads the file, extracts
 * via the selector, and returns the raw extracted result, so it works mid-route
 * via `.enrich()` / `.to()` (like an HTTP GET). With a static path it also
 * remains usable as a `.from()` source. Read mode returns `HtmlResult` directly;
 * the transformer-mode `to` mapping is not applied (mirroring how json/csv/jsonl
 * read modes return the raw parsed value and leave placement to `.enrich()`).
 */
export type HtmlReadAdapter<T = unknown, R = HtmlResult> = Transformer<T, R> &
  Source<HtmlResult> &
  Destination<unknown, HtmlResult> & { readonly adapterId: string };

/**
 * Create an HTML adapter that extracts data from HTML using CSS selectors (cheerio).
 *
 * **Transformer mode** (no path option):
 * - Extracts data from HTML string in exchange body
 * - By default uses body (or body.body when object) as HTML source
 * - Use `from` to read a sub-field and `to` to write result to a sub-field
 *
 * **Source/Destination mode** (with path option):
 * - As a **source** (.from): Reads HTML file, extracts data using selector
 * - As a **destination** (.to): Writes HTML string to file
 * - `mode: 'read'` extracts from the file mid-route and returns the result
 * - `mode: 'delete'` removes the file (idempotent) and passes the body through
 * - Uses file() adapter internally for I/O operations
 * - Supports file options: encoding, createDirs, mode
 *
 * @param options - selector, extract type, optional path for file I/O, optional from/to for transformer mode
 * @returns Transformer when no path; full HtmlAdapter (Transformer + Source + Destination) when path is provided
 *
 * @example
 * ```typescript
 * // Transformer mode (existing)
 * .transform(html({ selector: 'title', extract: 'text' }))
 *
 * // Source mode: read HTML file and extract
 * .from(html({ path: './page.html', selector: 'h1', extract: 'text' }))
 *
 * // Read mid-route: extract from a file and return the result
 * .enrich(html({ path: './page.html', selector: 'h1', mode: 'read' }), only((h1) => h1, 'h1'))
 *
 * // Destination mode: write HTML to file
 * .to(html({ path: './output.html', mode: 'write' }))
 *
 * // Delete an HTML file (idempotent)
 * .to(html({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
 * ```
 */
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R> & {
    path: string | ((exchange: Exchange) => string);
    mode: "read";
  },
): HtmlReadAdapter<T, R>;
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R> & {
    path: string | ((exchange: Exchange) => string);
  },
): HtmlAdapter<T, R>;
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R> & { path?: undefined },
): Transformer<T, R> & { readonly adapterId: string };
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R>,
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | HtmlAdapter<T, R>
  | HtmlReadAdapter<T, R> {
  const args = factoryArgs(options);
  const transformer = new HtmlTransformerAdapter<T, R>(options);
  if (options.path) {
    const destination = new HtmlDestinationAdapter<T, R>(options);

    // The source only supports static string paths. Build it for string paths;
    // for dynamic (function) paths, expose a `subscribe` that throws the same
    // clear error lazily, mirroring json's file adapter, so dynamic-path
    // destinations (write / read / delete) still work.
    const subscribe: CallableSource<HtmlResult> =
      typeof options.path === "string"
        ? new HtmlSourceAdapter<T, R>(options).subscribe
        : async () => {
            throw new Error(
              "html adapter: source mode requires a static string path (dynamic paths are only supported for destinations)",
            );
          };

    return tagAdapter(
      {
        adapterId: "routecraft.adapter.html",
        transform: transformer.transform.bind(transformer),
        subscribe,
        send: destination.send,
      },
      html,
      args,
    ) as unknown as HtmlAdapter<T, R> | HtmlReadAdapter<T, R>;
  }
  return {
    adapterId: "routecraft.adapter.html",
    transform: transformer.transform.bind(transformer),
  };
}

// Re-export types
export type { HtmlOptions, HtmlResult } from "./types.ts";
