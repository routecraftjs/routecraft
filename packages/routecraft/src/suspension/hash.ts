import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Adapter, Step } from "../types.ts";
import type { SerializedExchange, SuspensionExpect } from "./types.ts";

/**
 * Hash the continuation of a parked exchange: the steps that have NOT run
 * yet, plus the schema the eventual answer is validated against.
 *
 * ## Why the tail and not the pipeline
 *
 * Steps before the suspend point already ran. Changing one cannot affect
 * what happens after resume, so including them would invalidate every
 * approval in flight on any deploy that touched the route, and the approver
 * would discover it by clicking a dead link. Hashing from `position + 1`
 * onward keeps the property worth keeping (a change to what the approval
 * authorizes invalidates it) and drops the one that made it unusable.
 *
 * ## What the hash does NOT cover
 *
 * Step DEFINITIONS only. A `direct()` route the tail forwards to, an
 * adapter version, an environment variable, or any external system the tail
 * reaches can all change freely without moving this hash. That residue is
 * deliberate, and the mitigations are the catchable error-channel re-ask
 * path and `actionFingerprint`'s audit binding. Never describe the hash as
 * covering more than step definitions.
 *
 * ## What makes it move
 *
 * Each step contributes its operation kind, its DSL label, its adapter id,
 * the source text of the callables the adapter carries (where a user's
 * inline lambda lives), and the adapter's own data properties (where an
 * adapter's options live). So `.transform((p) => payOut(p))` becoming
 * `.transform((p) => payOutTwice(p))` moves the hash, and so does
 * `http({ url: bankA })` becoming `http({ url: bankB })`, while editing
 * `payOut` itself does not: that is the "step definitions only" boundary
 * stated above, seen from the other side.
 *
 * One operational consequence to plan around: function source is a property
 * of the BUILD, not just the source tree. A rebuild that changes emitted
 * text (a different minifier, new bundler settings, a TypeScript target
 * bump) moves the hash for steps it touched even when the code did not
 * change. Parked exchanges then re-enter their route's error channel and
 * can be re-asked, which is a survivable outcome by design, but a
 * deployment that parks approvals for days should keep its build settings
 * stable across releases.
 *
 * @param steps - The full step array of the route, in declaration order.
 * @param position - Index of the suspending step. The hash covers
 *   `position + 1` onward.
 * @param expect - The expected-result schema descriptor.
 * @returns A hex SHA-256 digest.
 *
 * @internal
 */
export function continuationHash(
  steps: ReadonlyArray<Step<Adapter>>,
  position: number,
  expect: SuspensionExpect,
): string {
  const tail = steps.slice(position + 1).map(describeStep);
  return sha256(canonical({ tail, expect: expect.hash }));
}

/**
 * Describe the expected-result schema for storage and hashing.
 *
 * The schema itself is a live object with a validate function, so it cannot
 * be persisted. What is persisted is this descriptor: a hash that folds
 * into {@link continuationHash} so a schema changed under a parked exchange
 * is caught, plus an optional JSON Schema rendering for the caller and the
 * operator. Validation at resume always runs against the live schema read
 * back off the route.
 *
 * The rendering comes from the non-standard `~standard.jsonSchema`
 * extension that Zod, ArkType, and the AI SDK bridge expose. Standard
 * Schema itself defines no JSON Schema export, so a schema library without
 * that extension simply yields no rendering; nothing else changes.
 *
 * @param schema - The `expect` schema declared on `.suspend()`.
 * @returns A serializable descriptor of the schema.
 *
 * @internal
 */
export function describeExpect(schema: StandardSchemaV1): SuspensionExpect {
  const standard = (
    schema as {
      "~standard"?: {
        vendor?: string;
        version?: number;
        jsonSchema?: { input?: unknown; output?: unknown };
      };
    }
  )["~standard"];
  const jsonSchema =
    standard?.jsonSchema?.output ?? standard?.jsonSchema?.input;
  // With a JSON Schema rendering the hash tracks the actual contract, so a
  // widened field moves it. Without one there is nothing to read: fall back
  // to the vendor and version, which at least catches a swapped schema
  // library, and let the resume-time validation against the live schema be
  // the real check.
  const identity =
    jsonSchema !== undefined
      ? { jsonSchema }
      : {
          vendor: standard?.vendor ?? "unknown",
          version: standard?.version ?? 0,
        };
  return {
    hash: sha256(canonical(identity)),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
  };
}

/**
 * Bind an approval to the operation it authorized.
 *
 * Without this, a receipt says "someone approved suspension abc123". With
 * it, the receipt says "this principal authorized this exact operation on
 * this exact payload". It costs one hash and turns the audit trail from a
 * reference into evidence.
 *
 * This is audit-grade binding, not a second access control: the frozen
 * exchange already stops payload tampering, and `continuationHash` already
 * catches a changed continuation.
 *
 * @param input - Route identity, suspend position, the continuation hash,
 *   and the serialized exchange whose body was shown to the approver.
 * @returns A hex SHA-256 digest.
 *
 * @internal
 */
export function actionFingerprint(input: {
  routeId: string;
  position: number;
  continuationHash: string;
  exchange: SerializedExchange;
}): string {
  return sha256(
    canonical({
      routeId: input.routeId,
      position: input.position,
      continuationHash: input.continuationHash,
      body: input.exchange.body,
    }),
  );
}

/**
 * Reduce a step to the parts that define what it will do.
 *
 * Two kinds of own property carry that definition, and both have to be in
 * the digest. Callables are where an inline lambda lives on a plain-object
 * adapter (`.transform((p) => payOut(p))`). Data properties are where an
 * adapter's OPTIONS live: a class-based adapter such as the http enricher
 * keeps its config in an `options` property and exposes a `fetch` whose
 * source text is identical for every instance, so hashing callables alone
 * would give `http({ url: bankA })` and `http({ url: bankB })` the same
 * digest and let a parked approval resume into a different payee.
 *
 * `adapterId` is read separately and excluded from the config walk so it is
 * not counted twice.
 *
 * @internal
 */
function describeStep(step: Step<Adapter>): unknown {
  const adapter = step.adapter as Record<string, unknown> | undefined;
  const callables: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  if (adapter) {
    for (const key of Object.keys(adapter).sort()) {
      if (key === "adapterId") continue;
      const value = adapter[key];
      if (typeof value === "function") callables[key] = normalizeSource(value);
      else config[key] = describable(value);
    }
  }
  return {
    operation: step.operation,
    label: step.label ?? null,
    adapterId: (adapter?.["adapterId"] as string | undefined) ?? null,
    callables,
    config,
  };
}

/**
 * Project an adapter option into something hashable.
 *
 * Total by construction, because adapters legitimately hold live clients,
 * sockets and credentials alongside their config. Anything the digest
 * cannot represent collapses to a stable placeholder rather than throwing:
 * a step whose adapter holds a socket must still be hashable, it just
 * cannot contribute that field to the comparison.
 *
 * @internal
 */
function describable(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") return Number.isFinite(value) ? value : "[number]";
  if (kind === "bigint") return `[bigint:${String(value)}]`;
  if (kind === "undefined") return undefined;
  if (kind === "symbol" || kind === "function") return "[unhashable]";
  if (value instanceof Date) return value.toISOString();
  // Bound the walk: a deeply nested or self-referential options object must
  // not turn hashing a route into a graph traversal.
  if (depth >= 4) return "[deep]";
  if (Array.isArray(value)) {
    return value.map((entry) => describable(entry, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value as object);
  if (prototype !== Object.prototype && prototype !== null) return "[opaque]";
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = describable(entry, depth + 1);
  }
  return projected;
}

/**
 * Collapse insignificant whitespace in a function's source so a formatter
 * pass (or a line-ending change between checkouts) does not read as a
 * changed continuation. Identifier renames and real edits still move it.
 *
 * @internal
 */
function normalizeSource(fn: object): string {
  return Function.prototype.toString.call(fn).replace(/\s+/g, " ").trim();
}

/**
 * Deterministic JSON with object keys sorted at every depth, so two
 * structurally equal values always hash to the same digest regardless of
 * insertion order.
 *
 * @internal
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
  return `{${entries.join(",")}}`;
}

/** @internal */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
