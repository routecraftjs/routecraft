import type { Source } from "../../operations/from.ts";
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
 * Create an HTML adapter that extracts data from HTML using CSS selectors (cheerio).
 *
 * @beta
 * **Transformer mode** (no path option):
 * - Extracts data from HTML string in exchange body
 * - By default uses body (or body.body when object) as HTML source
 * - Use `from` to read a sub-field and `to` to write result to a sub-field
 *
 * **Source/Destination mode** (with path option):
 * - As a **source** (.from): Reads HTML file, extracts data using selector
 * - As a **destination** (.to): Writes HTML string to file
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
 * // Destination mode: write HTML to file
 * .to(html({ path: './output.html', mode: 'write' }))
 * ```
 */
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
): (Transformer<T, R> & { readonly adapterId: string }) | HtmlAdapter<T, R> {
  const transformer = new HtmlTransformerAdapter<T, R>(options);
  if (options.path) {
    const source = new HtmlSourceAdapter<T, R>(options);
    const destMode = options.mode === "read" ? undefined : options.mode;
    const destination = new HtmlDestinationAdapter({
      path: options.path,
      mode: destMode,
      encoding: options.encoding,
      createDirs: options.createDirs,
    });
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.html",
        transform: transformer.transform.bind(transformer),
        subscribe: source.subscribe,
        send: destination.send,
      },
      html,
      factoryArgs(options),
    );
  }
  return {
    adapterId: "routecraft.adapter.html",
    transform: transformer.transform.bind(transformer),
  };
}

// Re-export types
export type { HtmlOptions, HtmlResult } from "./types.ts";
