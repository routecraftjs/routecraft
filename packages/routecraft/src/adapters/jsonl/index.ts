import type { Source, CallableSource } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { JsonlFileOptions, JsonlTransformerOptions } from "./types.ts";
import { JsonlSourceAdapter } from "./source.ts";
import { JsonlDestinationAdapter } from "./destination.ts";
import { JsonlEnricherAdapter } from "./enricher.ts";
import { JsonlTransformerAdapter } from "./transformer.ts";

/**
 * Combined JSONL file adapter type: all three roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches).
 *
 * @template T - Element type of the parsed array (caller-asserted)
 */
export type JsonlAdapter<T = unknown> = Source<T[]> &
  Destination<unknown> &
  Enricher<unknown, T[]> & { readonly adapterId: string };

/**
 * Chunked JSONL adapter: identical to {@link JsonlAdapter} except the source
 * emits one exchange per line (`T`) instead of one `T[]` array. The
 * send/fetch roles are unchanged (the chunked option concerns the subscribe
 * role only).
 *
 * @template T - Element type of each emitted line (caller-asserted)
 */
export type JsonlChunkedAdapter<T = unknown> = Source<T> &
  Destination<unknown> &
  Enricher<unknown, T[]> & { readonly adapterId: string };

/**
 * Creates a JSONL adapter in chunked source mode: one exchange per line with
 * `JsonlHeaders.LINE` and `JsonlHeaders.PATH` headers. `chunked` must be the
 * literal `true`; a widened boolean is a compile error, so dynamic chunking
 * is an explicit branch at the call site.
 *
 * @param options - JSONL file options with chunked: true
 * @returns The combined adapter with a per-line Source
 */
export function jsonl<T = unknown>(
  options: JsonlFileOptions & { chunked: true },
): JsonlChunkedAdapter<T>;
/**
 * Creates a JSONL adapter for a JSON Lines file. One factory, one type; the
 * POSITION in the route selects the role:
 *
 * - **`.from(jsonl({ path }))`** reads + parses the file and emits the
 *   array (`chunked: true` emits one exchange per line).
 * - **`.to(jsonl({ path }))`** stringifies the body to JSONL and writes it
 *   (overwrite; `append: true` appends; `delete: true` removes the file).
 *   Array bodies write one line per element. The body flows through
 *   unchanged.
 * - **`.enrich(jsonl({ path }))`** reads + parses mid-route; the array
 *   replaces the body (pass an aggregator such as `only()` to merge
 *   instead).
 *
 * @param options - JSONL file path, encoding, append/delete, and parse options
 * @returns The combined Source + Destination + Enricher adapter
 *
 * @example
 * ```typescript
 * // Read JSONL as array
 * .from(jsonl({ path: './events.jsonl' }))
 *
 * // Read JSONL per-line
 * .from(jsonl({ path: './events.jsonl', chunked: true }))
 *
 * // Read mid-route (the parsed array replaces the body)
 * .enrich(jsonl({ path: './events.jsonl' }))
 *
 * // Append to JSONL (an event log)
 * .to(jsonl({ path: './output.jsonl', append: true }))
 *
 * // Delete a JSONL file (idempotent)
 * .to(jsonl({ path: (ex) => ex.body.processedPath, delete: true }))
 * ```
 */
export function jsonl<T = unknown>(
  options: JsonlFileOptions & { chunked?: false },
): JsonlAdapter<T>;
/**
 * Creates a JSONL transformer that parses a JSONL string already in the body.
 *
 * @param options - Transformer options (`from`, `to`, `reviver`); no `path`
 * @returns A Transformer
 */
export function jsonl<T = unknown, R = unknown>(
  options?: JsonlTransformerOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
export function jsonl<T = unknown, R = unknown>(
  options: JsonlFileOptions | JsonlTransformerOptions<T, R> = {},
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | JsonlChunkedAdapter<T>
  | JsonlAdapter<T> {
  const args = factoryArgs(options);

  // Transformer role: no path means parse a JSONL string already in the
  // body. The `.transform()` keyword enforces the category, so dropping
  // `path` fails loudly at `.from()` / `.to()` instead of silently changing
  // the adapter's kind.
  if (
    !("path" in options) ||
    (options as JsonlFileOptions).path === undefined
  ) {
    const transformer = new JsonlTransformerAdapter<T, R>(
      options as JsonlTransformerOptions<T, R>,
    );
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.jsonl",
        transform: transformer.transform.bind(transformer),
      },
      jsonl,
      args,
    ) as Transformer<T, R> & { readonly adapterId: string };
  }

  const fileOptions = options as JsonlFileOptions;

  const destination = new JsonlDestinationAdapter(fileOptions);
  const enricher = new JsonlEnricherAdapter<T>(fileOptions);

  // The source role requires a static string path (no exchange exists at
  // subscribe time). A function path keeps the honest combined type; its
  // subscribe throws the same clear error lazily so `.from()` misuse fails
  // with a message instead of an undefined-property TypeError.
  const subscribe: CallableSource<T | T[]> =
    typeof fileOptions.path === "string"
      ? new JsonlSourceAdapter<T>(
          fileOptions as JsonlFileOptions & { path: string },
        ).subscribe
      : async () => {
          throw staticSourcePathError("jsonl");
        };

  return tagAdapter(
    {
      adapterId: "routecraft.adapter.jsonl",
      subscribe,
      send: destination.send,
      fetch: enricher.fetch,
    },
    jsonl,
    args,
  ) as unknown as JsonlChunkedAdapter<T> | JsonlAdapter<T>;
}

// Re-export types
export type {
  JsonlFileOptions,
  JsonlTransformerOptions,
  JsonlOptions,
} from "./types.ts";
import { staticSourcePathError } from "../shared/file-role-guards.ts";
export { JsonlHeaders } from "./types.ts";
