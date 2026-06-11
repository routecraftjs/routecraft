import {
  CraftClient,
  HeadersKeys,
  isAuthentic,
  markAuthentic,
  rcError,
  type Capability,
  type CraftContext,
  type KnownTag,
  type Principal,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { randomUUID } from "node:crypto";
import type {
  FnHandlerContext,
  FnOptions,
  ReadonlyPrincipal,
} from "../../fn/types.ts";
import { DEFERRED_FN_BRAND, type DeferredFn } from "./types.ts";

/**
 * Re-hydrate a frozen `ReadonlyPrincipal` (as exposed on
 * `FnHandlerContext`) into a fresh mutable `Principal` so it can be
 * attached to a downstream `DefaultExchange`.
 *
 * Arrays are spread-cloned and `claims` is deep-cloned via
 * `structuredClone` so the downstream principal shares no references
 * with the agent's frozen snapshot.
 *
 * Authenticity is forwarded only when the principal that triggered the
 * agent was itself authentic: `isAuthentic(rp)` is true for a JWT /
 * `authenticate()` identity (the tool-bridge preserves the trusted-origin
 * signal on the frozen snapshot) and false for a self-asserted plain-object
 * principal. Re-branding restores the brand the spread strips for the
 * legitimate case; leaving it unbranded for the self-asserted case lets the
 * downstream route's `authorize()` correctly reject it with RC5023, instead
 * of laundering an unverified caller into a trusted one across the
 * agent -> tool boundary. The agent layer never mints or escalates: it only
 * forwards the identity it was handed.
 */
function cloneFrozenPrincipal(rp: ReadonlyPrincipal): Principal {
  const out: Principal = { ...rp } as Principal;
  if (rp.audience) out.audience = [...rp.audience];
  if (rp.scopes) out.scopes = [...rp.scopes];
  if (rp.roles) out.roles = [...rp.roles];
  if (rp.claims)
    out.claims = structuredClone(rp.claims) as Record<string, unknown>;
  return isAuthentic(rp) ? markAuthentic(out) : out;
}

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
 * built-in fn factories so this module stays free of a Zod runtime dependency
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
 * Only `description` and `input` may be overridden. Guards are policy
 * and live at the consumer (attach them in `tools([{ name, guard }])`
 * at the agent's call site). Tags were previously overridable to
 * influence the removed tag-based selector; without that selector the
 * override has no effect at runtime, so the field is gone.
 */
export interface ToolBuilderOverrides<TIn = unknown> {
  /** Replace the underlying description shown to the LLM. */
  description?: string;
  /**
   * Replace the underlying input schema. Replaces, does not merge with,
   * the underlying schema.
   */
  input?: StandardSchemaV1<unknown, TIn>;
}

/**
 * Wrap a registered direct route as a fn-shaped tool. The route's
 * `.description()`, `.input()` schema, and tags become the fn's
 * description, input, and tags by default; pass `overrides` to narrow
 * `description` or `input` for the calling agent.
 *
 * Resolution is deferred to agent dispatch time, when the direct
 * registry is populated. Errors at resolution (unknown route id,
 * missing description, missing input schema) throw `RC5003`.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     fetchOrder: directTool("fetch-order"),
 *     safeFetchOrder: directTool("fetch-order", {
 *       description: "Read-only order fetch.",
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
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "direct",
    targetId: routeId,
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
      const tags = route.tags;
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

function readDirectRoute(
  ctx: CraftContext,
  routeId: string,
  fnId: string,
): Capability {
  const capabilities = ctx.capabilities();
  const route = capabilities.find((c) => c.endpoint === routeId);
  if (!route) {
    const known = capabilities.map((c) => c.endpoint).sort();
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
  // Forward the calling principal so the downstream direct route sees
  // the same authenticated identity as the agent that invoked the
  // tool. The agent layer never lets a tool override or escalate this:
  // `principal` is deeply-readonly on FnHandlerContext (frozen at the
  // tool-bridge boundary). Hand the downstream exchange a fresh
  // mutable copy so a `.process()` step downstream may legitimately
  // attach a different principal; the tool handler's own snapshot
  // stays frozen and unaffected.
  const headers: Record<string, unknown> = {};
  if (hctx.correlationId) {
    headers[HeadersKeys.CORRELATION_ID] = hctx.correlationId;
  }
  if (hctx.principal) {
    headers[HeadersKeys.AUTH_PRINCIPAL] = cloneFrozenPrincipal(hctx.principal);
  }
  return new CraftClient(ctx).sendDirect(
    routeId,
    input,
    Object.keys(headers).length > 0 ? headers : undefined,
  );
}

/**
 * Built-in fn factory: returns the current UTC timestamp in ISO 8601
 * format. Takes no configuration. Assign it a tool name in your
 * `agentPlugin({ functions: { ... } })` config, the same way you use
 * `directTool(...)`.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     CurrentTime: currentTime(),
 *     fetchOrder: directTool("fetch-order"),
 *   },
 * });
 * ```
 */
export function currentTime(): FnOptions {
  return {
    description: "Returns the current UTC timestamp in ISO 8601 format.",
    input: emptyObjectSchema,
    handler: () => new Date().toISOString(),
    tags: ["read-only", "idempotent"] satisfies KnownTag[],
  };
}

/**
 * Built-in fn factory: generates a fresh random UUID v4. Takes no
 * configuration. Assign it a tool name in your
 * `agentPlugin({ functions: { ... } })` config.
 *
 * @example
 * ```ts
 * agentPlugin({ functions: { RandomUuid: randomUuid() } });
 * ```
 */
export function randomUuid(): FnOptions {
  return {
    description: "Generates a fresh random UUID v4.",
    input: emptyObjectSchema,
    handler: () => randomUUID(),
    tags: ["read-only"] satisfies KnownTag[],
  };
}
