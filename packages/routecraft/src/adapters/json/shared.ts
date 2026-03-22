import type { JsonOptions, JsonFileOptions } from "./types.ts";

export function getText<T>(
  body: T,
  from: ((body: T) => string) | undefined,
): string {
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
export function getByPath(obj: unknown, path: string): unknown {
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

/**
 * Detect if options indicate file mode vs transformer mode.
 */
export function isFileMode<T = unknown, R = unknown, V = unknown>(
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
  const pathStr = options.path as string;
  const hasPathSeparator = pathStr.includes("/") || pathStr.includes("\\");
  const hasWindowsDrive = /^[a-z]:/i.test(pathStr);

  return hasPathSeparator || hasWindowsDrive;
}
