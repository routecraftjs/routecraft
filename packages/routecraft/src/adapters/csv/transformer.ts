import type { Transformer } from "../../operations/transform.ts";
import type { CsvTransformerOptions } from "./types.ts";
import { parseCsv } from "./shared.ts";
import { getBodyText } from "../shared/body-text.ts";

/**
 * CsvTransformerAdapter parses a CSV string already in the exchange body into
 * rows. It is the decode counterpart to the file source: use it when the CSV
 * text arrived in-memory (e.g. an HTTP response) rather than from disk.
 *
 * Requires `papaparse` to be installed as a peer dependency.
 */
export class CsvTransformerAdapter<
  T = unknown,
  R = unknown,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvTransformerOptions<T, R>) {}

  transform(body: T): R {
    const text = getBodyText(body, this.options.from, "csv");
    const rows = parseCsv(text, this.options);
    const to = this.options.to;
    if (to) return to(body, rows);
    return rows as unknown as R;
  }
}
