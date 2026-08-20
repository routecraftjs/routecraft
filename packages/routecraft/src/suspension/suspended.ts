import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isBranded, setBrand } from "../brand.ts";

/**
 * What execution one returns when a route parks.
 *
 * A durable suspend cannot hold a caller: the answer arrives in hours or
 * days and the process will be restarted first. So the run that reaches a
 * `.suspend()` terminates there and answers immediately with this value
 * instead of the route's declared output. The real output flows to the
 * route's destinations on execution two.
 *
 * Every source renders it in its own terms (`202` plus this body on
 * `http()`, the value itself on `direct()`, a log line on `cron()` /
 * `simple()` / file sources, an ack on queue sources), which is why a route
 * with a reachable durable suspend has output type `Output | Suspended`.
 *
 * The value is deliberately transport-shaped and JSON-safe: it crosses the
 * wire to whoever called the route.
 */
export interface Suspended {
  readonly status: "suspended";
  /** The parked exchange's suspension id. */
  readonly suspensionId: string;
  /** Signed, single-use token that resumes it. */
  readonly token: string;
  /**
   * JSON Schema rendering of what a valid answer looks like, when the
   * suspending step declared a schema and it exposes one (Zod, ArkType and
   * the AI SDK bridge do through the non-standard `~standard.jsonSchema`
   * extension). Absent otherwise, and absent whenever the site declared no
   * schema at all; validation always runs against the live schema at
   * resume, so nothing depends on this being present.
   */
  readonly schema?: unknown;
  /** When the suspension expires, ISO-8601. Absent when `.suspend()` declared no `ttl`. */
  readonly expiresAt?: string;
  /**
   * Human-facing question the suspension is waiting on. Populated when the
   * suspending step supplied one (the agent tier's `ctx.suspend()` is the
   * shipped producer); `.suspend()` deliberately has no option for it, since
   * a route notifies through ordinary steps before the park.
   */
  readonly question?: string;
  /** Machine-facing reason the run parked, when the suspending step supplied one. */
  readonly reason?: string;
}

/**
 * Mint the acknowledgment value for a parked exchange.
 *
 * Branded so a transport can recognise it (`http()` answers `202` rather
 * than `200`) without string-sniffing a `status` field that any user body
 * could also carry. The brand is a symbol-keyed own property, so it never
 * appears in the JSON that reaches the caller.
 *
 * @internal
 */
export function createSuspended(value: Omit<Suspended, "status">): Suspended {
  const suspended: Suspended = { status: "suspended", ...value };
  setBrand(suspended, BRAND.Suspended);
  return suspended;
}

/**
 * Whether a value is the framework's own {@link Suspended} acknowledgment.
 *
 * Transports call this on a route's terminal body to decide how to render
 * it. It is a brand check rather than a shape check on purpose: a route
 * whose real output happens to have `status: "suspended"` must not be
 * mistaken for a parked exchange.
 */
export function isSuspended(value: unknown): value is Suspended {
  return isBranded(value, BRAND.Suspended);
}

/**
 * JSON Schema for the {@link Suspended} acknowledgment, draft 2020-12.
 *
 * The shape a transport publishes when it advertises that a tool or route
 * may park: the MCP server derives `oneOf: [Output, Suspended]` for a
 * suspendable tool's `outputSchema` from this rendering. Closed for
 * additional properties so the advertised contract is exactly the value
 * {@link createSuspended} mints.
 */
export const SUSPENDED_JSON_SCHEMA = {
  type: "object",
  description:
    "The run parked at a durable suspension. Present the question to whoever can answer it; the answer is delivered out of band with the resume token, and the real result is produced when the run continues.",
  properties: {
    status: { const: "suspended" },
    suspensionId: { type: "string" },
    token: { type: "string" },
    schema: {
      description:
        "JSON Schema of what a valid answer looks like, when the suspending step declared a schema that renders one.",
    },
    expiresAt: { type: "string", format: "date-time" },
    question: { type: "string" },
    reason: { type: "string" },
  },
  required: ["status", "suspensionId", "token"],
  additionalProperties: false,
} as const;

/**
 * Standard Schema for the {@link Suspended} acknowledgment.
 *
 * Exists so surfaces that reason in schema arms (the MCP server's
 * advertised-output arms are the shipped consumer) can carry the
 * acknowledgment as an ordinary `StandardSchemaV1` next to a route's own
 * `.output()` schema. Validation accepts the framework's own acknowledgment
 * by brand first, so a genuine `Suspended` value always passes whatever a
 * structural check would say, and falls back to the structural check for
 * values that crossed a process boundary and lost the brand.
 */
export const suspendedSchema: StandardSchemaV1<unknown, Suspended> = {
  "~standard": {
    version: 1,
    vendor: "routecraft",
    validate(value) {
      if (isSuspended(value)) return { value };
      // Mirror SUSPENDED_JSON_SCHEMA exactly (types of the optional fields
      // included, undeclared string keys rejected) so the runtime check and
      // the advertised contract cannot say different things. The brand rides
      // a symbol key, which JSON never carries and Object.keys never lists.
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { status?: unknown }).status === "suspended" &&
        typeof (value as { suspensionId?: unknown }).suspensionId ===
          "string" &&
        typeof (value as { token?: unknown }).token === "string" &&
        Object.entries(value).every(([key, field]) => {
          switch (key) {
            case "status":
            case "suspensionId":
            case "token":
              return true;
            case "schema":
              return true;
            case "expiresAt":
            case "question":
            case "reason":
              return typeof field === "string";
            default:
              return false;
          }
        })
      ) {
        return { value: value as Suspended };
      }
      return {
        issues: [
          {
            message:
              'Expected the framework Suspended acknowledgment: { status: "suspended", suspensionId, token, ... } with no undeclared properties.',
          },
        ],
      };
    },
    // Non-standard `jsonSchema` extension, the same one Zod and ArkType
    // expose and the JSON Schema conversion sites look up defensively.
    jsonSchema: {
      input: () => SUSPENDED_JSON_SCHEMA,
      output: () => SUSPENDED_JSON_SCHEMA,
    },
  } as StandardSchemaV1<unknown, Suspended>["~standard"],
};
