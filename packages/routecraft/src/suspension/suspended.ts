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
   * `expect` schema exposes one (Zod, ArkType and the AI SDK bridge do
   * through the non-standard `~standard.jsonSchema` extension). Absent
   * otherwise; validation always runs against the live schema at resume, so
   * nothing depends on this being present.
   */
  readonly expect?: unknown;
  /** When the suspension expires, ISO-8601. Absent when `.suspend()` declared no `ttl`. */
  readonly expiresAt?: string;
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
