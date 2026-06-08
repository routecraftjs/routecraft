import { createRequire } from "node:module";
import type { CsvData, CsvParseOptions } from "./types.ts";

const require = createRequire(import.meta.url);

/**
 * Dynamically load papaparse and verify it is installed.
 * Throws with installation instructions if not available.
 *
 * @internal Not exported from the package public API.
 */
export function ensurePapaparse(): typeof import("papaparse") {
  try {
    const papa = require("papaparse");
    return papa.default || papa;
  } catch {
    throw new Error(
      "csv adapter requires 'papaparse' to be installed. Install it with: npm install papaparse",
    );
  }
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
