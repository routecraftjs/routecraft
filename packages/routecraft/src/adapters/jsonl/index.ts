import type { Source, CallableSource } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type {
  JsonlSourceOptions,
  JsonlDestinationOptions,
  JsonlCombinedOptions,
  JsonlTransformerOptions,
} from "./types.ts";
import { JsonlSourceAdapter } from "./source.ts";
import { JsonlDestinationAdapter } from "./destination.ts";
import { JsonlTransformerAdapter } from "./transformer.ts";

/**
 * Read-mode JSONL adapter. As a destination its `send` reads + parses the file
 * and returns the array, so it works mid-route via `.enrich()` / `.to()` (like
 * an HTTP GET). With a static path it also remains usable as a `.from()` source.
 */
export type JsonlReadAdapter<T = unknown> = Source<T[]> &
  Destination<unknown, T[]> & { readonly adapterId: string };

/**
 * Creates a JSONL transformer that parses a JSONL string already in the body.
 *
 * @param options - Transformer options (`from`, `to`, `reviver`); no `path`
 * @returns A Transformer
 */
export function jsonl<T = unknown, R = unknown>(
  options?: JsonlTransformerOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
/**
 * Creates a JSONL adapter in chunked source mode.
 * Emits one exchange per line with JSONL_LINE and JSONL_PATH headers.
 *
 * @param options - JSONL source options with chunked: true
 * @returns A Source-only adapter
 */
export function jsonl<T = unknown>(
  options: JsonlSourceOptions & { chunked: true },
): Source<T> & { readonly adapterId: string };
/**
 * Creates a read-mode JSONL adapter (source, and destination that returns the
 * parsed array mid-route).
 *
 * @param options - JSONL options with mode: 'read'
 * @returns A Source + read Destination adapter
 */
export function jsonl<T = unknown>(
  options: JsonlDestinationOptions & { mode: "read" },
): JsonlReadAdapter<T>;
/**
 * Creates a JSONL adapter for reading or writing JSON Lines files.
 *
 * As a **source** (.from):
 * - Non-chunked (default): reads and parses all lines, emits a single T[] array
 * - Chunked: emits one exchange per line
 *
 * As a **destination** (.to):
 * - Stringifies exchange body to a single JSONL line
 * - Array bodies write one line per element
 * - Default mode is append
 * - `mode: 'read'` returns the parsed array mid-route; `mode: 'delete'` removes
 *   the file (idempotent) and passes the body through
 *
 * @param options - JSONL file path, encoding, mode, and parse options
 * @returns Combined Source and Destination adapter
 *
 * @example
 * ```typescript
 * // Parse a JSONL string already in the body (transformer mode)
 * .transform(jsonl({ from: (b) => b.body }))
 *
 * // Read JSONL as array
 * .from(jsonl({ path: './events.jsonl' }))
 *
 * // Read JSONL per-line
 * .from(jsonl({ path: './events.jsonl', chunked: true }))
 *
 * // Read mid-route (destination that returns the parsed array)
 * .enrich(jsonl({ path: './events.jsonl', mode: 'read' }), only((rows) => rows, 'rows'))
 *
 * // Write to JSONL (append by default)
 * .to(jsonl({ path: './output.jsonl' }))
 *
 * // Delete a JSONL file (idempotent)
 * .to(jsonl({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
 * ```
 */
export function jsonl<T = unknown>(
  options: JsonlCombinedOptions,
): Source<T[]> & Destination<unknown, void> & { readonly adapterId: string };
/**
 * Creates a JSONL destination-only adapter.
 *
 * @param options - JSONL destination options (with dynamic path or destination-only fields)
 * @returns A Destination-only adapter
 */
export function jsonl(
  options: JsonlDestinationOptions,
): Destination<unknown, void> & { readonly adapterId: string };
export function jsonl<T = unknown, R = unknown>(
  options:
    | JsonlSourceOptions
    | JsonlDestinationOptions
    | JsonlCombinedOptions
    | JsonlTransformerOptions<T, R> = {},
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | Source<T>
  | Source<T[]>
  | JsonlReadAdapter<T>
  | Destination<unknown, void>
  | (Source<T[]> & Destination<unknown, void>) {
  const args = factoryArgs(options);

  // Transformer mode: no path means parse a JSONL string already in the body.
  if (
    !("path" in options) ||
    (options as JsonlDestinationOptions).path === undefined
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

  // Destination-only: path is a function (not valid for source)
  if (typeof (options as JsonlDestinationOptions).path === "function") {
    const destOptions = options as JsonlDestinationOptions;
    const destination = new JsonlDestinationAdapter(destOptions);
    // A function path cannot be a source. Read mode returns JsonlReadAdapter
    // (which includes Source); attach a subscribe that throws the same clear
    // error lazily, mirroring csv/json/html, so `.from()` misuse fails with a
    // message instead of an undefined-property TypeError.
    const subscribe: CallableSource<T> = async () => {
      throw new Error(
        "jsonl adapter: source mode requires a static string path (dynamic paths are only supported for destinations)",
      );
    };
    const tagged = tagAdapter(
      {
        adapterId: "routecraft.adapter.jsonl",
        subscribe,
        send: destination.send,
      },
      jsonl,
      args,
    );
    if (destOptions.mode === "read") {
      return tagged as unknown as JsonlReadAdapter<T>;
    }
    return tagged as unknown as Destination<unknown, void>;
  }

  const sourceOptions = options as JsonlSourceOptions;
  const source = new JsonlSourceAdapter<T>(sourceOptions);

  if (sourceOptions.chunked) {
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.jsonl",
        subscribe: source.subscribe,
      },
      jsonl,
      args,
    ) as Source<T>;
  }

  const combined = options as JsonlCombinedOptions;
  const destOptions: JsonlDestinationOptions = {
    path: sourceOptions.path,
  };
  if (sourceOptions.encoding) {
    destOptions.encoding = sourceOptions.encoding;
  }
  if (combined.mode) {
    destOptions.mode = combined.mode;
  }
  if (combined.createDirs) {
    destOptions.createDirs = combined.createDirs;
  }
  if (combined.replacer) {
    destOptions.replacer = combined.replacer;
  }
  if (sourceOptions.reviver) {
    destOptions.reviver = sourceOptions.reviver;
  }
  const destination = new JsonlDestinationAdapter(destOptions);

  const tagged = tagAdapter(
    {
      adapterId: "routecraft.adapter.jsonl",
      subscribe: source.subscribe,
      send: destination.send,
    },
    jsonl,
    args,
  );
  if (combined.mode === "read") {
    return tagged as unknown as JsonlReadAdapter<T>;
  }
  return tagged as unknown as Source<T[]> & Destination<unknown, void>;
}

// Re-export types
export type {
  JsonlSourceOptions,
  JsonlDestinationOptions,
  JsonlCombinedOptions,
  JsonlTransformerOptions,
  JsonlOptions,
} from "./types.ts";
