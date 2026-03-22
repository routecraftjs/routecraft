import type { Transformer } from "../../operations/transform.ts";
import type { JsonTransformerOptions } from "./types.ts";
import { getText, getByPath } from "./shared.ts";

/**
 * JsonTransformerAdapter parses a JSON string and optionally extracts a value by path.
 */
export class JsonTransformerAdapter<
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
