import { type Transformer } from "../operations/transform.ts";
import { file, type FileAdapter, type FileOptions } from "./file.ts";
import { type Source, type CallableSource } from "../operations/from.ts";
import {
  type Destination,
  type CallableDestination,
} from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";

// Transformer-mode options (current behavior)
export interface JsonTransformerOptions<T = unknown, R = unknown, V = unknown> {
  /**
   * Dot-notation path to extract from the parsed JSON, e.g. "data.items[0].name".
   * If omitted, the full parsed JSON is returned.
   * NOTE: In transformer mode only. In file mode, this parameter is the file path.
   */
  path?: string;
  /** Pluck JSON string from body. If omitted: body is used when it's a string, or body.body when body is an object (e.g. after http()). */
  from?: (body: T) => string;
  /**
   * Extract or transform the parsed value; return type V is inferred and used for result (and for to(body, result)).
   * When omitted, parsed/path result is used as-is and typed as unknown.
   */
  getValue?: (parsed: unknown) => V;
  /** Where to put the parsed/extracted result. If omitted, result replaces the entire body (same default as from). Use e.g. (body, result) => ({ ...body, parsed: result }) to write to a sub-field. Result is typed as V when getValue is provided. */
  to?: (body: T, result: V) => R;
}

// Source/Destination mode options (new behavior)
export interface JsonFileOptions {
  /**
   * File path string or function that returns the path.
   * Makes json() a source/destination adapter instead of a transformer.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * File operation mode.
   * - 'read': Read JSON file (source mode)
   * - 'write': Write/overwrite JSON file (destination mode)
   * - 'append': Append to JSON file (destination mode)
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append";

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * Number of spaces for JSON formatting (destination mode only).
   * Default: 0 (compact JSON)
   * Alias: Can also use 'indent' for compatibility.
   */
  space?: number;

  /**
   * Alias for 'space'. Number of spaces for JSON formatting.
   */
  indent?: number;

  /**
   * JSON.parse reviver function (source mode only).
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * JSON.stringify replacer function (destination mode only).
   */
  replacer?: (key: string, value: unknown) => unknown;
}

export type JsonOptions<T = unknown, R = unknown, V = unknown> =
  | JsonTransformerOptions<T, R, V>
  | JsonFileOptions;

function getText<T>(body: T, from: ((body: T) => string) | undefined): string {
  if (from) return from(body);
  if (typeof body === "string") return body;
  if (
    body &&
    typeof body === "object" &&
    "body" in body &&
    typeof (body as { body: unknown }).body === "string"
  ) {
    return (body as { body: string }).body;
  }
  throw new Error(
    "json adapter: body must be a string, an object with a string body property (e.g. http() result), or provide a from() option",
  );
}

/**
 * Get a value from an object by dot path with optional [index] for arrays.
 * e.g. "data.items[0].name" -> obj.data.items[0].name
 */
function getByPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return obj;
  const segments = trimmed.split(".").filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    const bracket = seg.indexOf("[");
    if (bracket === -1) {
      current = (current as Record<string, unknown>)[seg];
      continue;
    }
    const key = seg.slice(0, bracket);
    const indexMatch = seg.slice(bracket).match(/^\[(\d+)\]$/);
    if (key) {
      current = (current as Record<string, unknown>)[key];
    }
    if (indexMatch) {
      const index = Number(indexMatch[1]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
}

export class JsonAdapter<
  T = unknown,
  R = unknown,
  V = unknown,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.json";

  constructor(private readonly options: JsonTransformerOptions<T, R, V>) {}

  transform(body: T): R {
    const text = getText(body, this.options.from);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`json adapter: failed to parse JSON: ${message}`);
    }
    const path = this.options.path?.trim();
    const pathResult = path ? getByPath(parsed, path) : parsed;
    const result = this.options.getValue
      ? this.options.getValue(pathResult)
      : pathResult;

    const to = this.options.to;
    if (to) return to(body, result as V) as R;
    return result as unknown as R;
  }
}

// New adapter for source/destination mode
export class JsonFileAdapter
  implements Source<unknown>, Destination<unknown, void>
{
  readonly adapterId = "routecraft.adapter.json.file";
  private readonly fileAdapter: FileAdapter | null = null;

  constructor(private readonly options: JsonFileOptions) {
    // For source mode (read), create file adapter immediately with the path
    // For destination mode (write), we'll create it per-send if path is dynamic
    if (typeof options.path === "string") {
      // Build options object, only including defined properties to satisfy exactOptionalPropertyTypes
      const fileOptions: FileOptions = { path: options.path };
      if (options.mode !== undefined) fileOptions.mode = options.mode;
      if (options.encoding !== undefined)
        fileOptions.encoding = options.encoding;
      if (options.createDirs !== undefined)
        fileOptions.createDirs = options.createDirs;

      this.fileAdapter = file(fileOptions);
    }
  }

  /**
   * Source implementation: read JSON file and parse it.
   */
  subscribe: CallableSource<unknown> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    if (!this.fileAdapter) {
      throw new Error(
        "json adapter: dynamic paths (path as function) are only supported for destination mode",
      );
    }

    // Use file adapter to read, then parse JSON
    return this.fileAdapter.subscribe(
      context,
      async (content: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content, this.options.reviver as never);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`json adapter: failed to parse JSON: ${message}`);
        }
        // Call handler and return the exchange it produces
        return await handler(parsed);
      },
      abortController,
      onReady,
    );
  };

  /**
   * Destination implementation: stringify and write JSON file.
   */
  send: CallableDestination<unknown, void> = async (exchange) => {
    const { space, indent, replacer, path: filePath } = this.options;
    // Use indent if provided, otherwise space, default to 0
    const formatting = indent ?? space ?? 0;

    // Resolve path (static or dynamic)
    // IMPORTANT: Resolve path BEFORE stringifying so dynamic path function
    // has access to the original exchange.body object
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Stringify the body
    let jsonString: string;
    try {
      jsonString = JSON.stringify(exchange.body, replacer as never, formatting);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`json adapter: failed to stringify JSON: ${message}`);
    }

    // Create new exchange with stringified content
    const stringExchange: Exchange = {
      ...exchange,
      body: jsonString,
    };

    // Create or use file adapter with resolved path
    let adapter = this.fileAdapter;
    if (!adapter) {
      // Build options object, only including defined properties to satisfy exactOptionalPropertyTypes
      const fileOptions: FileOptions = { path: resolvedPath };
      if (this.options.mode !== undefined) fileOptions.mode = this.options.mode;
      if (this.options.encoding !== undefined)
        fileOptions.encoding = this.options.encoding;
      if (this.options.createDirs !== undefined)
        fileOptions.createDirs = this.options.createDirs;

      adapter = file(fileOptions);
    }

    // Write using file adapter
    return adapter.send(stringExchange);
  };
}

/**
 * Creates a JSON adapter.
 *
 * @beta
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
 * // Destination mode
 * .to(json({ path: './output.json', space: 2 }))
 * .to(json({ path: (ex) => `./data/${ex.body.id}.json`, createDirs: true }))
 * ```
 */
/**
 * Detect if options indicate file mode vs transformer mode.
 * File mode is indicated by:
 * - path is a function (dynamic file paths), OR
 * - path looks like a file path (contains file extension or path separators), OR
 * - any file-specific options are present (watch, mode, createDirs, encoding, indent, space, reviver, replacer)
 *
 * Transformer mode (dot-notation extraction) is indicated by:
 * - path is a simple dot-notation string without file indicators (e.g., "data.items")
 */
function isFileMode<T = unknown, R = unknown, V = unknown>(
  options: JsonOptions<T, R, V>,
): options is JsonFileOptions {
  if (!("path" in options) || options.path === undefined) {
    return false;
  }

  // If path is a function, it's definitely file mode
  if (typeof options.path === "function") {
    return true;
  }

  // Check for file-specific options - if any are present, it's file mode
  const fileOptions = options as JsonFileOptions;
  if (
    fileOptions.mode ||
    fileOptions.createDirs ||
    fileOptions.encoding ||
    fileOptions.space !== undefined ||
    fileOptions.indent !== undefined ||
    fileOptions.reviver ||
    fileOptions.replacer
  ) {
    return true;
  }

  // If path is a string, check if it looks like a file path
  // File paths typically contain:
  // - Path separators (/, \)
  // - Start with ./ or ../ (relative paths)
  // - Start with / (absolute path on Unix)
  // - Contain : (Windows drive letter like C:)
  //
  // Dot-notation paths for extraction are simpler:
  // - Just alphanumeric, dots, and brackets: "data.items[0].name"
  // - No slashes
  //
  // NOTE: We check for path separators FIRST, because that's the most reliable indicator.
  // File extensions alone are ambiguous (e.g., "data.items" could be extraction path).
  const pathStr = options.path as string;
  const hasPathSeparator = pathStr.includes("/") || pathStr.includes("\\");
  const hasWindowsDrive = /^[a-z]:/i.test(pathStr);

  return hasPathSeparator || hasWindowsDrive;
}

export function json<T, R, V>(
  options: JsonTransformerOptions<T, R, V> & {
    getValue: (parsed: unknown) => V;
    to?: undefined;
  },
): Transformer<T, V>;
export function json<T = unknown, R = unknown, V = unknown>(
  options?: JsonTransformerOptions<T, R, V>,
): Transformer<T, R>;
export function json(options: JsonFileOptions): JsonFileAdapter;
export function json<T = unknown, R = unknown, V = unknown>(
  options: JsonOptions<T, R, V> = {},
): Transformer<T, R> | Transformer<T, V> | JsonFileAdapter {
  // Check if this is file mode
  if (isFileMode(options)) {
    // File mode: return JsonFileAdapter
    // Cast to JsonFileOptions since isFileMode narrows the type
    return new JsonFileAdapter(options as JsonFileOptions);
  }

  // Transformer mode: return JsonAdapter
  return new JsonAdapter<T, R, V>(
    options as JsonTransformerOptions<T, R, V>,
  ) as unknown as Transformer<T, R> | Transformer<T, V>;
}
