import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Metadata for a discoverable CLI command route.
 * Registered in context store for help generation and dispatch.
 */
export interface CliRouteMetadata {
  command: string;
  description?: string;
  schema?: StandardSchemaV1;
}

/**
 * Options when using CLI adapter as a Server (.from()).
 * Defines the CLI command, its schema (flags), and description.
 */
export interface CliServerOptions {
  /**
   * Body validation schema. Object properties become CLI flags.
   * Only flat objects with primitive values are supported.
   *
   * Behavior depends on schema library:
   * - Zod 4: z.object() strips extras (default)
   * - Valibot/ArkType: check library docs
   */
  schema?: StandardSchemaV1;

  /** Human-readable description shown in help output. */
  description?: string;
}

/**
 * Options when using CLI adapter as a Client (.to()).
 */
export interface CliClientOptions {
  /** Output stream: "stdout" (default) or "stderr". */
  stream?: "stdout" | "stderr";
}

/** Options when using CLI as a server or client (union). */
export type CliOptions = CliServerOptions | CliClientOptions;
