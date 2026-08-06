import type { Source, CallableSource } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { Enricher } from "../../operations/enrich.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { HtmlTransformerAdapter } from "./transformer.ts";
import { HtmlSourceAdapter } from "./source.ts";
import { HtmlDestinationAdapter } from "./destination.ts";
import { HtmlEnricherAdapter } from "./enricher.ts";
import { staticSourcePathError } from "../shared/file-role-guards.ts";

/**
 * Combined HTML file adapter type: the file roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches). The transformer role lives on the no-`path` variant
 * of the factory (an extraction over the body needs no file).
 */
export type HtmlAdapter = Source<HtmlResult> &
  Destination<unknown> &
  Enricher<unknown, HtmlResult> & { readonly adapterId: string };

/**
 * Create an HTML adapter that extracts data from HTML using CSS selectors (cheerio).
 *
 * **Transformer role** (no `path` option): extracts data from the HTML
 * string in the exchange body. Use `from` to read a sub-field and `to` to
 * write the result to a sub-field.
 *
 * **File roles** (`path` present); the POSITION in the route selects the role:
 * - **`.from(html({ path, selector }))`** reads the file, extracts via the
 *   selector, and emits the result.
 * - **`.to(html({ path }))`** writes the HTML string from the body to the
 *   file (overwrite; `append: true` appends; `delete: true` removes the
 *   file). The body flows through unchanged.
 * - **`.enrich(html({ path, selector }))`** extracts from the file
 *   mid-route; the result replaces the body (pass an aggregator such as
 *   `only()` to merge instead).
 *
 * Requires `cheerio` to be installed as an optional peer dependency.
 *
 * @param options - selector, extract type, optional path for file roles, optional from/to for the transformer role
 * @returns A Transformer (no path) or the combined file adapter (path)
 *
 * @example
 * ```typescript
 * // Transformer role
 * .transform(html({ selector: 'title', extract: 'text' }))
 *
 * // Source role: read HTML file and extract
 * .from(html({ path: './page.html', selector: 'h1', extract: 'text' }))
 *
 * // Fetch mid-route: extract from a file and merge the result
 * .enrich(html({ path: './page.html', selector: 'h1' }), only((h1) => h1, 'h1'))
 *
 * // Send role: write HTML to file
 * .to(html({ path: './output.html' }))
 *
 * // Delete an HTML file (idempotent)
 * .to(html({ path: (ex) => ex.body.processedPath, delete: true }))
 * ```
 */
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R> & {
    path: string | ((exchange: Exchange) => string);
  },
): HtmlAdapter;
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R> & { path?: undefined },
): Transformer<T, R> & { readonly adapterId: string };
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R>,
): (Transformer<T, R> & { readonly adapterId: string }) | HtmlAdapter {
  const args = factoryArgs(options);
  if (options.path) {
    const destination = new HtmlDestinationAdapter<T, R>(options);
    const enricher = new HtmlEnricherAdapter<T, R>(options);

    // The source role requires a static string path. For dynamic (function)
    // paths, expose a `subscribe` that throws the same clear error lazily,
    // so send/fetch usage with a dynamic path still works.
    const subscribe: CallableSource<HtmlResult> =
      typeof options.path === "string"
        ? new HtmlSourceAdapter<T, R>(options).subscribe
        : async () => {
            throw staticSourcePathError("html");
          };

    return tagAdapter(
      {
        adapterId: "routecraft.adapter.html",
        subscribe,
        send: destination.send,
        fetch: enricher.fetch,
      },
      html,
      args,
    ) as HtmlAdapter;
  }
  const transformer = new HtmlTransformerAdapter<T, R>(options);
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.html",
      transform: transformer.transform.bind(transformer),
    },
    html,
    args,
  );
}

// Re-export types
export type { HtmlOptions, HtmlResult } from "./types.ts";
