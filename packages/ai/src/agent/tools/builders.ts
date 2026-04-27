import {
  ADAPTER_DIRECT_REGISTRY,
  DefaultExchange,
  HeadersKeys,
  getDirectChannel,
  rcError,
  sanitizeEndpoint,
  type CraftContext,
  type DirectRouteMetadata,
  type Exchange,
  type KnownTag,
  type Tag,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { randomUUID } from "node:crypto";
import type { FnHandlerContext, FnOptions } from "../../fn/types.ts";
import { DEFERRED_FN_BRAND, type DeferredFn } from "./types.ts";

/**
 * JSON Schema describing an empty object. Closed for additional
 * properties so the LLM can't confuse models that have more fields.
 */
const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

/**
 * Standard Schema implementation of an empty input object. Used by the
 * `defaultFns` so this module stays free of a Zod runtime dependency
 * (per CLAUDE.md "Use Standard Schema, not Zod/Valibot directly in
 * shared code").
 *
 * Exposes both `~standard.validate` (mandatory per the spec) and the
 * non-standard `~standard.jsonSchema.{input,output}` extension that
 * the Vercel AI SDK bridge consumes, so this hand-rolled schema can
 * back tools and structured-output specs alongside Zod / Valibot
 * schemas without special-casing.
 */
const emptyObjectSchema: StandardSchemaV1<unknown, Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value as object).length > 0
      ) {
        return {
          issues: [
            {
              message: "Expected an empty object {}.",
            },
          ],
        };
      }
      return { value: {} as Record<string, never> };
    },
    // Non-standard `jsonSchema` extension consumed by the AI SDK bridge.
    // Cast away from the strict StandardSchemaV1 shape since the spec
    // doesn't include this field; library schemas (Zod, Valibot) ship it
    // as an extension and the bridge looks it up defensively.
    jsonSchema: {
      input: () => EMPTY_OBJECT_JSON_SCHEMA,
      output: () => EMPTY_OBJECT_JSON_SCHEMA,
    },
  } as StandardSchemaV1<unknown, Record<string, never>>["~standard"],
};

/**
 * Per-call overrides accepted by the builder helpers. Lets the caller
 * narrow the underlying tool's surface to a specific agent without
 * touching the underlying registration.
 *
 * Only the LLM-facing contract (description, input, tags) can be
 * overridden here. Guards are policy and live at the consumer:
 * attach them in `tools([{ name, guard }])` at the agent's call site.
 *
 * @experimental
 */
export interface ToolBuilderOverrides<TIn = unknown> {
  /** Replace the underlying description shown to the LLM. */
  description?: string;
  /**
   * Replace the underlying input schema. Replaces, does not merge with,
   * the underlying schema.
   */
  input?: StandardSchemaV1<unknown, TIn>;
  /**
   * Replace the underlying tags. Replaces, does not merge with, the
   * underlying tags.
   */
  tags?: Tag[];
}

/**
 * Wrap a registered direct route as a fn-shaped tool. The route's
 * `.description()`, `.input()` schema, and tags become the fn's
 * description, input, and tags by default; pass `overrides` to narrow
 * any of them for the calling agent.
 *
 * Resolution is deferred to agent dispatch time, when the direct
 * registry is populated. Errors at resolution (unknown route id,
 * missing description, missing input schema) throw `RC5003`.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     fetchOrder: directTool("fetch-order"),
 *     safeFetchOrder: directTool("fetch-order", {
 *       description: "Read-only order fetch.",
 *       tags: ["read-only"],
 *     }),
 *   },
 * });
 * ```
 */
export function directTool<TIn = unknown>(
  routeId: string,
  overrides?: ToolBuilderOverrides<TIn>,
): DeferredFn {
  if (typeof routeId !== "string" || routeId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `directTool: routeId must be a non-empty string.`,
    });
  }
  const overrideTags = normalizeOverrideTags(overrides?.tags, routeId);
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "direct",
    targetId: routeId,
    ...(overrideTags !== undefined ? { overrideTags } : {}),
    resolve(ctx, fnId): FnOptions {
      const route = readDirectRoute(ctx, routeId, fnId);
      const description = overrides?.description ?? route.description;
      if (typeof description !== "string" || description.trim() === "") {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .description() and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const input =
        overrides?.input ??
        (route.input?.body as StandardSchemaV1<unknown, TIn> | undefined);
      if (!input) {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .input(...) schema and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const tags = overrideTags ?? route.tags;
      const handler = ((input, hctx) =>
        dispatchDirect(ctx, hctx, routeId, input)) as FnOptions["handler"];
      return {
        description,
        input,
        ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
        handler,
      } as FnOptions;
    },
  };
}

/**
 * Trim and validate user-supplied builder override tags so they match
 * exact tag selectors and surface clear errors on misuse. Returns
 * `undefined` when no override was supplied (so the caller can omit
 * the field entirely on the descriptor).
 */
function normalizeOverrideTags(
  value: Tag[] | undefined,
  routeId: string,
): readonly Tag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw rcError("RC5003", undefined, {
      message: `directTool("${routeId}"): override "tags" must be an array of non-empty strings.`,
    });
  }
  const out: Tag[] = [];
  for (const t of value) {
    if (typeof t !== "string" || t.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `directTool("${routeId}"): override "tags" must contain only non-empty strings.`,
      });
    }
    const trimmed = t.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function readDirectRoute(
  ctx: CraftContext,
  routeId: string,
  fnId: string,
): DirectRouteMetadata {
  const registry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;
  // Direct sources register under the sanitised endpoint, so look up
  // by sanitised key. Reject the raw id in the error message so the
  // user can see which one they wrote.
  const endpoint = sanitizeEndpoint(routeId);
  const route = registry?.get(endpoint);
  if (!route) {
    const known = registry ? [...registry.keys()].sort() : [];
    throw rcError("RC5003", undefined, {
      message:
        `directTool: unknown direct route id "${routeId}" (referenced as fn "${fnId}"). ` +
        (known.length > 0
          ? `Known route ids: ${known.join(", ")}.`
          : `No direct routes are registered in this context.`),
    });
  }
  return route;
}

async function dispatchDirect<TIn>(
  ctx: CraftContext,
  hctx: FnHandlerContext,
  routeId: string,
  input: TIn,
): Promise<unknown> {
  const endpoint = sanitizeEndpoint(routeId);
  const headers = hctx.correlationId
    ? { [HeadersKeys.CORRELATION_ID]: hctx.correlationId }
    : undefined;
  const exchange = new DefaultExchange<TIn>(ctx, {
    body: input,
    ...(headers ? { headers } : {}),
  });
  const channel = getDirectChannel<TIn>(ctx, endpoint, {});
  const result = (await channel.send(endpoint, exchange)) as Exchange<unknown>;
  return result.body;
}

/**
 * Wrap a registered agent as a fn-shaped tool. Lands in story F (sub-
 * agents). Available now as a builder so the prefix auto-resolution
 * path in `tools(...)` can recognise `agent_*` and emit a clear "not
 * supported yet" error rather than treating the name as an unknown fn.
 *
 * @experimental
 */
export function agentTool(
  agentId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- shape mirrors the future story F signature
  _overrides?: never,
): DeferredFn {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `agentTool: agentId must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "agent",
    targetId: agentId,
    resolve(_ctx, fnId): FnOptions {
      throw rcError("RC5003", undefined, {
        message: `agentTool("${agentId}") (referenced as fn "${fnId}") is not yet supported. Sub-agent tools land in a follow-up story.`,
      });
    },
  };
}

/**
 * Wrap an MCP tool as a fn-shaped tool. Lands in story E (MCP tools).
 * Available now as a builder so the prefix auto-resolution path in
 * `tools(...)` can recognise `mcp_*` and emit a clear "not supported
 * yet" error.
 *
 * @experimental
 */
export function mcpTool(
  serverId: string,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- shape mirrors the future story E signature
  _overrides?: never,
): DeferredFn {
  if (typeof serverId !== "string" || serverId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `mcpTool: serverId must be a non-empty string.`,
    });
  }
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `mcpTool: toolName must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "mcp",
    targetId: `${serverId}:${toolName}`,
    resolve(_ctx, fnId): FnOptions {
      throw rcError("RC5003", undefined, {
        message: `mcpTool("${serverId}", "${toolName}") (referenced as fn "${fnId}") is not yet supported. MCP tools land in a follow-up story.`,
      });
    },
  };
}

/**
 * Small starter set of generic, broadly useful fns. Spread into your
 * `agentPlugin({ functions: { ... } })` config to give every agent in
 * the context the basics for free.
 *
 * @experimental
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     ...defaultFns,
 *     fetchOrder: directTool("fetch-order"),
 *   },
 * });
 * ```
 */
export const defaultFns = {
  currentTime: {
    description: "Returns the current UTC timestamp in ISO 8601 format.",
    input: emptyObjectSchema,
    handler: () => new Date().toISOString(),
    tags: ["read-only", "idempotent"] satisfies KnownTag[],
  } satisfies FnOptions<Record<string, never>, string>,
  randomUuid: {
    description: "Generates a fresh random UUID v4.",
    input: emptyObjectSchema,
    handler: () => randomUUID(),
    tags: ["read-only"] satisfies KnownTag[],
  } satisfies FnOptions<Record<string, never>, string>,
};
