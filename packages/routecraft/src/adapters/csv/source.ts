import type { Source, CallableSource } from "../../operations/from.ts";
import type { CsvOptions, CsvData } from "./types.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";

/**
 * CsvSourceAdapter reads CSV files and parses them to arrays of objects.
 */
export class CsvSourceAdapter implements Source<CsvData> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvOptions) {}

  subscribe: CallableSource<CsvData> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
    } = this.options;

    const fileAdapter = file({
      path: this.options.path,
      encoding: this.options.encoding || "utf-8",
    });

    await fileAdapter.subscribe(
      context,
      async (csvContent: string) => {
        try {
          const parseResult = Papa.parse(csvContent, {
            header,
            delimiter,
            quoteChar,
            skipEmptyLines,
          });

          if (parseResult.errors.length > 0) {
            const firstError = parseResult.errors[0];
            throw new Error(
              `csv adapter: parse error at row ${firstError.row}: ${firstError.message}`,
            );
          }

          return await handler(parseResult.data as CsvData);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`csv adapter: failed to parse CSV: ${message}`);
        }
      },
      abortController,
      onReady,
    );
  };
}
