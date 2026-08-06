import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { JsonlFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { parseJsonl } from "./shared.ts";

/**
 * JsonlEnricherAdapter implements the Enricher (fetch) role for JSON Lines
 * files: `fetch` reads the resolved path, parses every line, and returns the
 * array, so `.enrich(jsonl({ path }))` pulls a JSONL file into the route
 * mid-flow. Parse failures throw (the route boundary surfaces them as
 * `exchange:failed`); the `onParseError` lifecycle controls apply to the
 * source role only.
 *
 * @template T - Element type of the parsed array (caller-asserted)
 */
export class JsonlEnricherAdapter<T = unknown> implements Enricher<
  unknown,
  T[]
> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlFileOptions) {}

  /** Fetch implementation: read the resolved path and return the parsed array. */
  fetch: CallableEnricher<unknown, T[]> = async (exchange, ctx) => {
    const { path: filePath, encoding = "utf-8", reviver } = this.options;
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;
    const content = await file({ path: resolvedPath, encoding }).fetch(
      exchange,
      ctx,
    );
    return parseJsonl(content, reviver) as T[];
  };
}
