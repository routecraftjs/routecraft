import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isBranded, setBrand } from "../brand.ts";

/**
 * What execution one returns when a route defers.
 *
 * A durable defer cannot hold a caller: the resume payload arrives in
 * hours or days and the process will be restarted first. So the run that
 * reaches a `.defer()` terminates there and replies immediately with this value
 * instead of the route's declared output. The real output flows to the
 * route's destinations on execution two.
 *
 * Every source renders it in its own terms (`202` plus this body on
 * `http()`, the value itself on `direct()`, a log line on `cron()` /
 * `simple()` / file sources, an ack on queue sources), which is why a route
 * with a reachable durable defer has output type `Output | Deferred`.
 *
 * The value is deliberately transport-shaped and JSON-safe: it crosses the
 * wire to whoever called the route.
 */
export interface Deferred {
  readonly status: "deferred";
  /** The deferred exchange's deferral id. */
  readonly deferralId: string;
  /** Signed, single-use token that resumes it. */
  readonly token: string;
  /**
   * JSON Schema rendering of what a valid resume payload looks like, when the
   * deferring step declared a schema and it exposes one (Zod, ArkType and
   * the AI SDK bridge do through the non-standard `~standard.jsonSchema`
   * extension). Absent otherwise, and absent whenever the site declared no
   * schema at all; validation always runs against the live schema at
   * resume, so nothing depends on this being present.
   */
  readonly schema?: unknown;
  /** When the deferral expires, ISO-8601. Absent when `.defer()` declared no `ttl`. */
  readonly expiresAt?: string;
}

/**
 * Mint the acknowledgment value for a deferred exchange.
 *
 * Branded so a transport can recognise it (`http()` answers `202` rather
 * than `200`) without string-sniffing a `status` field that any user body
 * could also carry. The brand is a symbol-keyed own property, so it never
 * appears in the JSON that reaches the caller.
 *
 * @internal
 */
export function createDeferred(value: Omit<Deferred, "status">): Deferred {
  const deferred: Deferred = { status: "deferred", ...value };
  setBrand(deferred, BRAND.Deferred);
  return deferred;
}

/**
 * Whether a value is the framework's own {@link Deferred} acknowledgment.
 *
 * Transports call this on a route's terminal body to decide how to render
 * it. It is a brand check rather than a shape check on purpose: a route
 * whose real output happens to have `status: "deferred"` must not be
 * mistaken for a deferred exchange.
 */
export function isDeferred(value: unknown): value is Deferred {
  return isBranded(value, BRAND.Deferred);
}

/**
 * JSON Schema for the {@link Deferred} acknowledgment, draft 2020-12.
 *
 * The shape a transport publishes when it advertises that a tool or route
 * may defer: the MCP server derives `oneOf: [Output, Deferred]` for a
 * deferrable tool's `outputSchema` from this rendering. Closed for
 * additional properties so the advertised contract is exactly the value
 * {@link createDeferred} mints.
 */
export const DEFERRED_JSON_SCHEMA = {
  type: "object",
  description:
    "The run deferred at a durable deferral. The resume payload is delivered out of band with the resume token, and the real result is produced when the run continues.",
  properties: {
    status: { const: "deferred" },
    deferralId: { type: "string" },
    token: { type: "string" },
    schema: {
      description:
        "JSON Schema of what a valid resume payload looks like, when the deferring step declared a schema that renders one.",
    },
    expiresAt: { type: "string", format: "date-time" },
  },
  required: ["status", "deferralId", "token"],
  additionalProperties: false,
} as const;

/**
 * Standard Schema for the {@link Deferred} acknowledgment.
 *
 * Exists so surfaces that reason in schema arms (the MCP server's
 * advertised-output arms are the shipped consumer) can carry the
 * acknowledgment as an ordinary `StandardSchemaV1` next to a route's own
 * `.output()` schema. Validation accepts the framework's own acknowledgment
 * by brand first, so a genuine `Deferred` value always passes whatever a
 * structural check would say, and falls back to the structural check for
 * values that crossed a process boundary and lost the brand.
 */
export const deferredSchema: StandardSchemaV1<unknown, Deferred> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate(value) {
      if (isDeferred(value)) return { value };
      // Mirror DEFERRED_JSON_SCHEMA exactly (types of the optional fields
      // included, undeclared string keys rejected) so the runtime check and
      // the advertised contract cannot say different things. The brand rides
      // a symbol key, which JSON never carries and Object.keys never lists.
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { status?: unknown }).status === "deferred" &&
        typeof (value as { deferralId?: unknown }).deferralId === "string" &&
        typeof (value as { token?: unknown }).token === "string" &&
        Object.entries(value).every(([key, field]) => {
          switch (key) {
            case "status":
            case "deferralId":
            case "token":
              return true;
            case "schema":
              return true;
            case "expiresAt":
              return typeof field === "string";
            default:
              return false;
          }
        })
      ) {
        return { value: value as Deferred };
      }
      return {
        issues: [
          {
            message:
              'Expected the framework Deferred acknowledgment: { status: "deferred", deferralId, token, ... } with no undeclared properties.',
          },
        ],
      };
    },
    // Non-standard `jsonSchema` extension, the same one Zod and ArkType
    // expose and the JSON Schema conversion sites look up defensively.
    jsonSchema: {
      input: () => DEFERRED_JSON_SCHEMA,
      output: () => DEFERRED_JSON_SCHEMA,
    },
  } as StandardSchemaV1<unknown, Deferred>["~standard"],
};
