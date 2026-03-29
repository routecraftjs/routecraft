import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Reads a file line by line, invoking a callback for each line.
 * Supports abort via AbortSignal for cooperative cancellation.
 *
 * @internal Not exported from the package public API.
 *
 * @param filePath - Absolute or relative path to the file
 * @param encoding - Text encoding (e.g. 'utf-8')
 * @param signal - AbortSignal to cancel reading mid-stream
 * @param callback - Async function called for each line with the line content and 1-based line number
 */
export async function forEachLine(
  filePath: string,
  encoding: BufferEncoding,
  signal: AbortSignal,
  callback: (line: string, lineNumber: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;

  const stream = createReadStream(filePath, { encoding });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;

  const onAbort = () => {
    rl.close();
    stream.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const line of rl) {
      if (signal.aborted) break;
      lineNumber++;
      await callback(line, lineNumber);
      if (signal.aborted) break;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    rl.close();
    stream.destroy();
  }
}

/**
 * Throws a standardized file-related error for an adapter.
 * Handles ENOENT, EACCES, and generic errors.
 *
 * @internal Not exported from the package public API.
 *
 * @param adapter - Adapter name for the error prefix (e.g. 'file', 'csv', 'jsonl')
 * @param filePath - The file path that caused the error
 * @param err - The original error
 */
export function throwFileError(
  adapter: string,
  filePath: string,
  err: unknown,
): never {
  const message = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(`${adapter} adapter: file not found: ${filePath}`);
  }
  if ((err as NodeJS.ErrnoException).code === "EACCES") {
    throw new Error(
      `${adapter} adapter: permission denied reading file: ${filePath}`,
    );
  }
  throw new Error(`${adapter} adapter: failed to read file: ${message}`);
}
