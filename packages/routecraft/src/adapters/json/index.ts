import type { Source, CallableSource } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type {
  JsonTransformerOptions,
  JsonFileOptions,
  JsonOptions,
} from "./types.ts";
import { JsonTransformerAdapter } from "./transformer.ts";
import { JsonSourceAdapter } from "./source.ts";
import { JsonDestinationAdapter } from "./destination.ts";
import { JsonEnricherAdapter } from "./enricher.ts";
import { selectsFileRole } from "../shared/file-role-guards.ts";

/**
 * Combined JSON file adapter type: all three roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches). The parsed value is typed `T` (default `unknown`);
 * pass it explicitly (`json<Product[]>(...)`) for a typed body.
 *
 * @template T - Parsed value type (caller-asserted)
 */
export type JsonFileAdapterType<T = unknown> = Source<T> &
  Destination<unknown> &
  Enricher<unknown, T> & { readonly adapterId: string };

/**
 * Creates a JSON adapter.
 *
 * **Transformer role** (no `path` option):
 * Parses a JSON string and optionally extracts a value by `pointer`
 * (dot-notation into the parsed value). By default uses body (or body.body
 * when object) as the JSON string and replaces the body with the result.
 *
 * **File roles** (`path` present); the POSITION in the route selects the role:
 * - **`.from(json({ path }))`** reads + parses the file and emits the value.
 * - **`.to(json({ path }))`** stringifies the body and writes it (overwrite;
 *   `append: true` appends; `delete: true` removes the file). The body flows
 *   through unchanged.
 * - **`.enrich(json({ path }))`** reads + parses mid-route; the value
 *   replaces the body (pass an aggregator such as `only()` to merge instead).
 *
 * @param options - Transformer options (`from`, `pointer`, `getValue`, `to`) or file options (`path`, `space`, etc.)
 * @returns A Transformer (no path) or the combined file adapter (path)
 *
 * @example
 * ```typescript
 * // Transformer role
 * .transform(json({ pointer: 'data.items' }))
 * .transform(json({ from: (b) => b.raw, getValue: (p) => p as User[] }))
 *
 * // Source role
 * .from(json({ path: './data.json' }))
 *
 * // Read mid-route (the parsed value replaces the body)
 * .enrich(json<Product[]>({ path: './data.json' }), only((p) => p, 'catalogue'))
 *
 * // Send role (write)
 * .to(json({ path: './output.json', space: 2 }))
 * .to(json({ path: (ex) => `./data/${ex.body.id}.json`, createDirs: true }))
 * ```
 */
export function json<T, R, V>(
  options: JsonTransformerOptions<T, R, V> & {
    getValue: (parsed: unknown) => V;
    to?: undefined;
  },
): Transformer<T, V>;
export function json<T = unknown>(
  options: JsonFileOptions,
): JsonFileAdapterType<T>;
export function json<T = unknown, R = unknown, V = unknown>(
  options?: JsonTransformerOptions<T, R, V>,
): Transformer<T, R>;
export function json<T = unknown, R = unknown, V = unknown>(
  options: JsonOptions<T, R, V> = {},
): Transformer<T, R> | Transformer<T, V> | JsonFileAdapterType<T> {
  const args = factoryArgs(options);

  // File roles: `path` presence is the discriminator; `path` always means a
  // file path (the transformer's extraction key is `pointer`).
  // `path` is absent from the transformer half of the union, so read it
  // through an `in` check before handing it to the shared guard.
  if (selectsFileRole("json", "path" in options ? options.path : undefined)) {
    const fileOptions = options as JsonFileOptions;
    const destination = new JsonDestinationAdapter(fileOptions);
    const enricher = new JsonEnricherAdapter<T>(fileOptions);

    // The source role requires a static string path; a function path keeps
    // the honest combined type, and its subscribe throws the same clear
    // error lazily (the JsonSourceAdapter constructor enforces it).
    let sourceAdapter: JsonSourceAdapter | undefined;
    const subscribe: CallableSource<T> = async (sub) => {
      sourceAdapter ??= new JsonSourceAdapter(fileOptions);
      return sourceAdapter.subscribe(sub) as Promise<void>;
    };

    return tagAdapter(
      {
        adapterId: "routecraft.adapter.json.file",
        subscribe,
        send: destination.send,
        fetch: enricher.fetch,
      },
      json,
      args,
    ) as JsonFileAdapterType<T>;
  }

  return tagAdapter(
    new JsonTransformerAdapter<T, R, V>(
      options as JsonTransformerOptions<T, R, V>,
    ),
    json,
    args,
  ) as unknown as Transformer<T, R> | Transformer<T, V>;
}

// Re-export types
export type {
  JsonOptions,
  JsonTransformerOptions,
  JsonFileOptions,
} from "./types.ts";
