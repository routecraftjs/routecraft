import type { Transformer } from "../../operations/transform.ts";
import type { JsonlTransformerOptions } from "./types.ts";
import { parseJsonl } from "./shared.ts";
import { getBodyText } from "../shared/body-text.ts";

/**
 * JsonlTransformerAdapter parses a JSON Lines string already in the exchange
 * body into an array. It is the decode counterpart to the file source: use it
 * when the JSONL text arrived in-memory (e.g. an HTTP response) rather than
 * from disk.
 */
export class JsonlTransformerAdapter<
  T = unknown,
  R = unknown,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlTransformerOptions<T, R>) {}

  transform(body: T): R {
    const text = getBodyText(body, this.options.from, "jsonl");
    const rows = parseJsonl(text, this.options.reviver);
    const to = this.options.to;
    if (to) return to(body, rows);
    return rows as unknown as R;
  }
}
