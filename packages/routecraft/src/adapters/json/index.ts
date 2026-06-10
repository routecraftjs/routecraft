import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
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
import { isFileMode } from "./shared.ts";

/** Combined JSON file adapter type exposing Source and Destination interfaces. */
export type JsonFileAdapterType = Source<unknown> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Read-mode JSON adapter. As a destination its `send` reads + parses the file
 * and returns the parsed value, so it works mid-route via `.enrich()` / `.to()`
 * (like an HTTP GET). It remains usable as a `.from()` source. The parsed value
 * is typed `T` (default `unknown`); pass it explicitly (`json<Product[]>(...)`)
 * for a typed merge.
 */
export type JsonReadAdapter<T = unknown> = Source<T> &
  Destination<unknown, T> & { readonly adapterId: string };

/**
 * JsonFileAdapter combines source and destination for JSON file operations.
 * Source is created lazily since dynamic paths are only valid for destinations.
 * The destination `send` returns the parsed value in read mode and `void` when
 * writing, so its declared result type is widened to `unknown` here and
 * narrowed per mode by the `json()` factory's return type.
 */
class JsonFileAdapter
  implements Source<unknown>, Destination<unknown, unknown>
{
  readonly adapterId = "routecraft.adapter.json.file";
  private _source: JsonSourceAdapter | undefined;
  private readonly destination: JsonDestinationAdapter;
  private readonly options: JsonFileOptions;

  constructor(options: JsonFileOptions) {
    this.options = options;
    this.destination = new JsonDestinationAdapter(options);
  }

  get subscribe() {
    if (!this._source) {
      this._source = new JsonSourceAdapter(this.options);
    }
    return this._source.subscribe;
  }

  get send() {
    return this.destination.send;
  }
}

/**
 * Creates a JSON adapter.
 *
 * **Transformer mode** (when no `path` option):
 * Parses a JSON string and optionally extracts a value by path.
 * By default uses body (or body.body when object) as the JSON string and replaces the body with the result.
 *
 * **Source/Destination mode** (when `path` option is provided):
 * As a **source** (.from): Reads and parses JSON files
 * As a **destination** (.to): Stringifies and writes JSON files with optional formatting
 *
 * @param options - Transformer options (`from`, `getValue`, `to`) or file options (`path`, `space`, etc.)
 * @returns A Transformer (transformer mode) or Source/Destination adapter (file mode)
 *
 * @example
 * ```typescript
 * // Transformer mode
 * .transform(json({ path: 'data.items' }))
 * .transform(json({ from: (b) => b.raw, getValue: (p) => p as User[] }))
 *
 * // Source mode
 * .from(json({ path: './data.json' }))
 *
 * // Read mid-route (destination that returns the parsed value)
 * .enrich(json<Product[]>({ path: './data.json', mode: 'read' }), only((p) => p, 'catalogue'))
 *
 * // Destination mode (write)
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
export function json<T = unknown, R = unknown, V = unknown>(
  options?: JsonTransformerOptions<T, R, V>,
): Transformer<T, R>;
export function json<T = unknown>(
  options: JsonFileOptions & { mode: "read" },
): JsonReadAdapter<T>;
export function json(options: JsonFileOptions): JsonFileAdapterType;
export function json<T = unknown, R = unknown, V = unknown>(
  options: JsonOptions<T, R, V> = {},
):
  | Transformer<T, R>
  | Transformer<T, V>
  | JsonFileAdapterType
  | JsonReadAdapter<T> {
  const args = factoryArgs(options);
  if (isFileMode(options)) {
    const adapter = new JsonFileAdapter(options);
    const tagged = tagAdapter(adapter, json, args);
    // In read mode `send` resolves to the parsed value; narrow accordingly so
    // `.enrich()`/`.to()` infer the parsed body. Otherwise `send` is a write
    // (void). The runtime object is identical; only its declared type differs.
    if (options.mode === "read") {
      return tagged as unknown as JsonReadAdapter<T>;
    }
    return tagged as unknown as JsonFileAdapterType;
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
