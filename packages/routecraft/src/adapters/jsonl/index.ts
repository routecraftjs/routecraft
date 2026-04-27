import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type {
  JsonlSourceOptions,
  JsonlDestinationOptions,
  JsonlCombinedOptions,
} from "./types.ts";
import { JsonlSourceAdapter } from "./source.ts";
import { JsonlDestinationAdapter } from "./destination.ts";

/**
 * Creates a JSONL adapter in chunked source mode.
 * Emits one exchange per line with JSONL_LINE and JSONL_PATH headers.
 *
 * @beta
 * @param options - JSONL source options with chunked: true
 * @returns A Source-only adapter
 */
export function jsonl<T = unknown>(
  options: JsonlSourceOptions & { chunked: true },
): Source<T> & { readonly adapterId: string };
/**
 * Creates a JSONL adapter for reading or writing JSON Lines files.
 *
 * @beta
 * As a **source** (.from):
 * - Non-chunked (default): reads and parses all lines, emits a single T[] array
 * - Chunked: emits one exchange per line
 *
 * As a **destination** (.to):
 * - Stringifies exchange body to a single JSONL line
 * - Array bodies write one line per element
 * - Default mode is append
 *
 * @param options - JSONL file path, encoding, mode, and parse options
 * @returns Combined Source and Destination adapter
 *
 * @example
 * ```typescript
 * // Read JSONL as array
 * .from(jsonl({ path: './events.jsonl' }))
 *
 * // Read JSONL per-line
 * .from(jsonl({ path: './events.jsonl', chunked: true }))
 *
 * // Write to JSONL (append by default)
 * .to(jsonl({ path: './output.jsonl' }))
 * ```
 */
export function jsonl<T = unknown>(
  options: JsonlCombinedOptions,
): Source<T[]> & Destination<unknown, void> & { readonly adapterId: string };
/**
 * Creates a JSONL destination-only adapter.
 *
 * @beta
 * @param options - JSONL destination options (with dynamic path or destination-only fields)
 * @returns A Destination-only adapter
 */
export function jsonl(
  options: JsonlDestinationOptions,
): Destination<unknown, void> & { readonly adapterId: string };
export function jsonl<T = unknown>(
  options: JsonlSourceOptions | JsonlDestinationOptions | JsonlCombinedOptions,
):
  | Source<T>
  | Source<T[]>
  | Destination<unknown, void>
  | (Source<T[]> & Destination<unknown, void>) {
  const args = factoryArgs(options);

  // Destination-only: path is a function (not valid for source)
  if (typeof (options as JsonlDestinationOptions).path === "function") {
    const destination = new JsonlDestinationAdapter(
      options as JsonlDestinationOptions,
    );
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.jsonl",
        send: destination.send,
      },
      jsonl,
      args,
    ) as Destination<unknown, void>;
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
  const destination = new JsonlDestinationAdapter(destOptions);

  return tagAdapter(
    {
      adapterId: "routecraft.adapter.jsonl",
      subscribe: source.subscribe,
      send: destination.send,
    },
    jsonl,
    args,
  ) as Source<T[]> & Destination<unknown, void>;
}

// Re-export types
export type {
  JsonlSourceOptions,
  JsonlDestinationOptions,
  JsonlCombinedOptions,
  JsonlOptions,
} from "./types.ts";
