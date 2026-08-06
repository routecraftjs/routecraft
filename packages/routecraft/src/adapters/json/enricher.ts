import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { JsonFileOptions } from "./types.ts";
import { FileEnricherAdapter } from "../file/enricher.ts";

/**
 * JsonEnricherAdapter implements the Enricher (fetch) role for JSON files:
 * `fetch` reads the resolved path, `JSON.parse`s it, and returns the parsed
 * value, so `.enrich(json({ path }))` pulls a JSON file into the route
 * mid-flow. Parse failures throw (the route boundary surfaces them as
 * `exchange:failed`); the `onParseError` lifecycle controls apply to the
 * source role only.
 *
 * @template T - Parsed value type (caller-asserted, e.g. `json<Config>(...)`)
 */
export class JsonEnricherAdapter<T = unknown> implements Enricher<unknown, T> {
  readonly adapterId = "routecraft.adapter.json.file";

  constructor(private readonly options: JsonFileOptions) {}

  /** Fetch implementation: read the resolved path and return the parsed value. */
  fetch: CallableEnricher<unknown, T> = async (exchange, ctx) => {
    const { path: filePath, encoding, reviver } = this.options;
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;
    // Only the fetch slot is needed; skip the full file() facade on the
    // hot path.
    const content = await new FileEnricherAdapter({
      path: resolvedPath,
      encoding: encoding ?? "utf-8",
    }).fetch(exchange, ctx);
    try {
      return JSON.parse(content, reviver as never) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `json adapter: failed to parse JSON from ${resolvedPath}: ${message}`,
      );
    }
  };
}
