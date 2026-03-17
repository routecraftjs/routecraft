import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Exchange } from "@routecraft/routecraft";

/** Message type derived from schema S when present; otherwise unknown. */
export type McpMessage<S extends StandardSchemaV1 | undefined> =
  S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown;

/**
 * Extracts MCP tool arguments from an exchange. Default implementation uses exchange.body.
 */
export type McpArgsExtractor = (
  exchange: Exchange<unknown>,
) => Record<string, unknown>;

// Re-export from canonical location to avoid interface drift.
export type { McpClientHttpConfig } from "../../types.ts";
