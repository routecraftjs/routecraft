import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Input schema for the `WebFetch` tool.
 *
 * Hand-rolled rather than expressed in Zod because this module ships in
 * the published package, and CLAUDE.md keeps shared code on Standard
 * Schema alone. It exposes the same non-standard `~standard.jsonSchema`
 * extension the built-in fn factories use, which is what the Vercel AI
 * SDK bridge reads to describe the tool to a model.
 */

/** Validated shape handed to the WebFetch handler. */
export interface WebFetchInput {
  /** Absolute http(s) URL to read. */
  url: string;
  /**
   * Character offset into the page's markdown. Used to continue reading
   * a page whose previous response was truncated.
   */
  offset?: number;
}

const JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    url: {
      type: "string" as const,
      description: "The absolute http(s) URL to read.",
    },
    offset: {
      type: "integer" as const,
      minimum: 0,
      description:
        "Character offset to resume from. Use the offset named in a truncation notice to read the next section of a long page. Omit to start at the beginning.",
    },
  },
  required: ["url"],
  additionalProperties: false,
};

function issue(message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message }] };
}

/**
 * Validates `{ url, offset? }`.
 *
 * Only structural validation happens here. Whether the URL is safe to
 * dereference is decided by the egress guard at call time, because that
 * answer depends on DNS and on configuration the schema cannot see.
 */
export const webFetchInputSchema: StandardSchemaV1<unknown, WebFetchInput> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return issue('Expected an object with a "url" property.');
      }
      const record = value as Record<string, unknown>;

      // The published JSON Schema says additionalProperties: false, so
      // silently dropping an unknown key would let a model misspell
      // "offset" and read page one forever, believing it had paginated.
      const unknown = Object.keys(record).filter(
        (key) => key !== "url" && key !== "offset",
      );
      if (unknown.length > 0) {
        return issue(
          `Unknown propert${unknown.length === 1 ? "y" : "ies"} ${unknown
            .map((key) => `"${key}"`)
            .join(", ")}. This tool accepts only "url" and "offset".`,
        );
      }

      const url = record["url"];
      if (typeof url !== "string" || url.trim() === "") {
        return issue('"url" must be a non-empty string.');
      }

      const rawOffset = record["offset"];
      if (rawOffset === undefined || rawOffset === null) {
        return { value: { url: url.trim() } };
      }
      if (
        typeof rawOffset !== "number" ||
        !Number.isInteger(rawOffset) ||
        rawOffset < 0
      ) {
        return issue('"offset" must be a non-negative integer.');
      }
      return { value: { url: url.trim(), offset: rawOffset } };
    },
    // Only `input` is declared. `JSON_SCHEMA` describes `{ url, offset? }`,
    // which is this tool's input and not its output (`WebFetchResult`), so
    // pointing `output` at it would assert something false. The bridge's
    // output direction already falls back to `input`.
    jsonSchema: {
      input: () => JSON_SCHEMA,
    },
  } as StandardSchemaV1<unknown, WebFetchInput>["~standard"],
};
