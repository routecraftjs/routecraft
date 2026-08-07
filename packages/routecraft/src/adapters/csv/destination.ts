import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { CsvFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";
import { assertExclusiveSendBehavior } from "../shared/file-role-guards.ts";

/**
 * Record separator Papa emits between rows. `CsvFileOptions` exposes no
 * newline setting, so every chunk this adapter formats uses Papa's default
 * (CRLF, per RFC 4180). Appends to a file that already uses LF follow the
 * file instead, so a given file never ends up mixing the two.
 */
const DEFAULT_RECORD_SEPARATOR = "\r\n";

/**
 * Tail of the in-flight append chain per resolved path, shared across every
 * `CsvDestinationAdapter` in the process.
 *
 * An append is a read-then-write (does the file have content? then write the
 * header or not, and does it end mid-record?), so two concurrent appends to
 * one file could both observe "empty" and both emit a header. Keying the lock
 * on the path rather than on the adapter covers the case where two routes,
 * each with their own `csv()` instance, target the same file. A writer in
 * another process is still outside our reach.
 *
 * Entries are removed once their chain drains, so a route with per-exchange
 * dynamic paths does not accumulate one entry per path forever.
 */
const appendLocks = new Map<string, Promise<void>>();

/**
 * What the append target looks like at its tail, read before formatting so
 * the chunk can be terminated (and if needed prefixed) to keep row boundaries
 * intact.
 */
interface AppendTail {
  /** File exists and is non-empty (so a header would be a duplicate). */
  hasContent: boolean;
  /** File ends mid-record, so the new chunk needs a leading separator. */
  needsSeparator: boolean;
  /** Separator the file already uses, when its last record is terminated. */
  separator: string | undefined;
}

/**
 * Read the end of the append target to classify its tail. Reads a handful of
 * bytes rather than the file so appending to a large log stays cheap.
 *
 * The tail is decoded with the file's own encoding before the newline check:
 * in `utf16le` / `ucs2` a newline is two bytes (`0A 00`), so a raw byte
 * comparison would read the trailing NUL as "unterminated" and splice a blank
 * row into every append. Four bytes cover a CRLF in either width.
 *
 * @param filePath - Resolved path of the file about to be appended to
 * @param encoding - Encoding the adapter writes with
 */
async function inspectAppendTail(
  filePath: string,
  encoding: BufferEncoding,
): Promise<AppendTail> {
  const missing: AppendTail = {
    hasContent: false,
    needsSeparator: false,
    separator: undefined,
  };
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch (error) {
    // Only a genuinely absent file means "start fresh". Anything else
    // (permissions, a directory in the way) must surface: treating it as
    // missing would write a second header into a file that already has one.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return missing;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return missing;
    const length = Math.min(4, size);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, size - length);
    const tail = bytes.toString(encoding);
    if (!tail.endsWith("\n")) {
      // Ends mid-record: whoever wrote it left the row unterminated.
      return { hasContent: true, needsSeparator: true, separator: undefined };
    }
    return {
      hasContent: true,
      needsSeparator: false,
      separator: tail.endsWith("\r\n") ? "\r\n" : "\n",
    };
  } finally {
    await handle.close();
  }
}

/**
 * CsvDestinationAdapter implements the Destination (send) role for CSV files.
 *
 * `send` is strictly void: it formats the exchange body (object or array of
 * objects) as CSV and writes it (overwrite by default, `append: true` to
 * append with header handling, `delete: true` to remove the file). Reading
 * lives on the fetch role (CsvEnricherAdapter).
 */
export class CsvDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvFileOptions) {
    assertExclusiveSendBehavior("csv", options);
  }

  send: CallableDestination<unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Delete behavior: delegate to the file adapter (no format). Idempotent.
    if (this.options.delete) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    if (!this.options.append) {
      await this.write(exchange, resolvedPath);
      return;
    }

    // Serialise appends to this path: the previous append must have landed
    // before the next one inspects the file's tail. Keyed on the absolute
    // path so two adapters pointed at the same file share one chain.
    const lockKey = nodePath.resolve(resolvedPath);
    const previous = appendLocks.get(lockKey) ?? Promise.resolve();
    const current = previous
      // A failed append must not poison the chain for the next writer, so the
      // link the chain holds swallows the rejection; `current` below still
      // rethrows it to this caller.
      .catch(() => undefined)
      .then(() => this.write(exchange, resolvedPath));
    const queued = current.catch(() => undefined);
    appendLocks.set(lockKey, queued);
    try {
      await current;
    } finally {
      // Drop the entry only when nothing queued behind this append, so a
      // route writing per-exchange dynamic paths keeps the map at the size of
      // the in-flight set rather than of every path it has ever written.
      if (appendLocks.get(lockKey) === queued) appendLocks.delete(lockKey);
    }
  };

  private async write(
    exchange: Exchange<unknown>,
    resolvedPath: string,
  ): Promise<void> {
    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
      append = false,
      encoding = "utf-8",
    } = this.options;

    // Extract data from exchange body
    let data: Array<Record<string, unknown>>;
    if (Array.isArray(exchange.body)) {
      data = exchange.body;
    } else if (exchange.body && typeof exchange.body === "object") {
      data = [exchange.body as Record<string, unknown>];
    } else {
      throw new Error(
        "csv adapter: send role requires exchange body to be an object or array of objects",
      );
    }

    // Inspect the tail once: it decides both whether a header would duplicate
    // an existing one and whether the file's last record is terminated.
    const tail: AppendTail = append
      ? await inspectAppendTail(resolvedPath, encoding)
      : { hasContent: false, needsSeparator: false, separator: undefined };

    const includeHeader = header && !(append && tail.hasContent);
    let csvContent: string;
    try {
      csvContent = Papa.unparse(data, {
        header: includeHeader,
        delimiter,
        quotes: false,
        quoteChar,
        skipEmptyLines,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`csv adapter: failed to format CSV: ${message}`);
    }

    // Papa.unparse emits no trailing newline, so an append would splice the
    // new first record onto the previous last one ("a,b" + "c,d" =>
    // "a,bc,d"). Two boundaries need a separator: the one this chunk leaves
    // behind for the NEXT append, and the one an already-unterminated file
    // left behind for this one. Follow the separator the file already uses so
    // it never ends up mixing CRLF and LF.
    if (append && csvContent.length > 0) {
      const separator = tail.separator ?? DEFAULT_RECORD_SEPARATOR;
      if (tail.needsSeparator) csvContent = separator + csvContent;
      if (!csvContent.endsWith("\n")) csvContent += separator;
    }

    const fileAdapter = file({
      path: resolvedPath,
      encoding,
      append,
      createDirs: this.options.createDirs || false,
    });

    const fileExchange = {
      ...exchange,
      body: csvContent,
    };
    await fileAdapter.send(fileExchange);
  }
}
