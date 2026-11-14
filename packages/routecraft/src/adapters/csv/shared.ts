import { createRequire } from "node:module";
import { loadOptionalPeerSync } from "../shared/optional-peer.ts";
import type { CsvData, CsvParseOptions } from "./types.ts";

const require = createRequire(import.meta.url);

/**
 * Load papaparse, an optional peer.
 *
 * @throws RC5017 when papaparse is not installed
 *
 * @internal Not exported from the package public API.
 */
export function ensurePapaparse(): typeof import("papaparse") {
  const papa = loadOptionalPeerSync(
    () =>
      require("papaparse") as typeof import("papaparse") & {
        default?: typeof import("papaparse");
      },
    { consumer: "csv adapter", packageName: "papaparse" },
  );
  return papa.default ?? papa;
}

/**
 * Parse a CSV string into rows via PapaParse, throwing on the first error.
 *
 * Shared by source (non-chunked), the read-as-destination mode, and the
 * transformer so they all surface parse failures the same way.
 *
 * @internal Not exported from the package public API.
 */
export function parseCsv(content: string, options: CsvParseOptions): CsvData {
  const Papa = ensurePapaparse();
  const {
    header = true,
    delimiter = ",",
    quoteChar = '"',
    skipEmptyLines = true,
  } = options;
  const result = Papa.parse(content, {
    header,
    delimiter,
    quoteChar,
    skipEmptyLines,
  });
  if (result.errors.length > 0) {
    const firstError = result.errors[0];
    throw new Error(
      `csv adapter: parse error at row ${firstError.row}: ${firstError.message}`,
    );
  }
  return result.data as CsvData;
}
