import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { CsvFileOptions, CsvData } from "./types.ts";
import { file } from "../file/index.ts";
import { parseCsv } from "./shared.ts";

/**
 * CsvEnricherAdapter implements the Enricher (fetch) role for CSV files:
 * `fetch` reads the resolved path, parses it, and returns the rows, so
 * `.enrich(csv({ path }))` pulls a CSV into the route mid-flow. Parse
 * failures throw (the route boundary surfaces them as `exchange:failed`);
 * the `onParseError` lifecycle controls apply to the source role only.
 */
export class CsvEnricherAdapter implements Enricher<unknown, CsvData> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvFileOptions) {}

  /** Fetch implementation: read the resolved path and return the parsed rows. */
  fetch: CallableEnricher<unknown, CsvData> = async (exchange, ctx) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;
    const content = await file({
      path: resolvedPath,
      encoding: this.options.encoding || "utf-8",
    }).fetch(exchange, ctx);
    return parseCsv(content, this.options) as CsvData;
  };
}
