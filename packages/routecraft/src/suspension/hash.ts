import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getAdapterArgs } from "../adapters/shared/factory-tag.ts";
import type { Adapter, Step } from "../types.ts";
import {
  renderJsonSchemaArm,
  standardExtensionOf,
} from "../shared/standard-schema.ts";
import type { SerializedExchange, SuspensionSchema } from "./types.ts";

/**
 * Hash the continuation of a parked exchange: the steps that have NOT run
 * yet, plus the schema the eventual resume payload is validated against.
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
 * Option VALUES have their own residue, and it is narrower than it looks.
 * `describable` projects the carriers an adapter option realistically names
 * a target with (string, number, boolean, `Date`, `URL`, `RegExp`, `Map`,
 * `Set`, arrays, plain objects), but any other class instance collapses to
 * `[opaque]` and anything nested five deep collapses to `[deep]`. Two
 * options differing only there hash alike, so an adapter that hides its
 * target inside a bespoke config class is outside the compatibility check.
 * Prefer plain options on a route that suspends.
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
 * ## The design rule: never normalize the source
 *
 * Function source is taken VERBATIM. Do not add whitespace collapsing,
 * formatting normalization, or any other canonicalization ahead of this
 * digest, however safe a given transformation looks.
 *
 * The reasoning is asymmetric and it is the whole argument. Normalization
 * can only ever fold two distinct sources onto one digest. Every such fold
 * is a chance to MISS a change, and a missed change means a parked approval
 * resumes into behaviour its approver never authorized. The opposite error,
 * treating an inert edit as a change, costs an error-channel re-ask, which
 * is a path this design already provides and expects to be used.
 *
 * This was learned rather than assumed. An earlier revision normalized
 * whitespace outside string literals with a hand-rolled scanner. Review
 * found three separate ways to desynchronize it (automatic semicolon
 * insertion, regex literals, and an apostrophe inside a comment), each
 * fixable only by moving closer to a real JavaScript tokenizer, and each
 * failing in the direction that resumes a parked approval into different
 * behaviour. The scanner was deleted rather than completed.
 *
 * ## What that costs, and why it is the right trade
 *
 * The hash reads emitted text, so it is sensitive to more than the source
 * tree: a formatting pass, a checkout with different line endings, or a
 * build that changes emitted text (a different minifier, new bundler
 * settings, a TypeScript target bump) all move it for steps whose behaviour
 * did not change. Every one of those outcomes is an error-channel re-ask,
 * never a wrong resume. Deployments that park approvals for days should pin
 * line endings and build settings; the configuration reference says so for
 * users.
 *
 * @param tail - Steps from the one after the suspending step to the end.
 * @param schema - The resume-payload schema descriptor.
 * @returns A hex SHA-256 digest.
 *
 * @internal
 */

/**
 * Hash an already-resolved continuation tail. The tail is exactly what a
 * resume would run, which for a static `.suspend()` is the steps after it
 * and for a re-entrant site includes the suspending step itself at its
 * head. Same digest as {@link continuationHash} over the equivalent slice,
 * so records parked before this helper existed keep verifying.
 *
 * @internal
 */
export function continuationTailHash(
  tail: ReadonlyArray<Step<Adapter>>,
  schema: SuspensionSchema,
): string {
  return sha256(
    canonical({
      tail: tail.map(describeStep),
      // Kept under the historical key so a digest computed before the
      // rename verifies unchanged. The wire and the record moved; this
      // string is an internal hash input nobody reads.
      expect: schema.hash,
    }),
  );
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
 * The extension's arms may be the rendered schema OR a function that
 * produces it on demand (Zod 4 ships the lazy form), so
 * {@link renderJsonSchemaArm} resolves either. Storing the unresolved function instead would be
 * quietly destructive twice over: it cannot be persisted, and it hashes to
 * the same digest for EVERY schema, which silently disables the
 * changed-schema half of the compatibility check.
 *
 * A site that declares NO schema gets the absent sentinel rather than an
 * empty descriptor. The two are different facts and must hash differently:
 * "declared a schema whose rendering was lost" still validates the payload at
 * resume, while "declared nothing" does not, so collapsing them would let an
 * edit between the two pass the compatibility check unnoticed.
 *
 * @param schema - The `schema` declared on `.suspend()`, if any.
 * @returns A serializable descriptor of the schema.
 *
 * @internal
 */
export function describeSchema(schema?: StandardSchemaV1): SuspensionSchema {
  if (!schema) {
    return { hash: sha256(canonical({ absent: true })), absent: true };
  }
  const standard = standardExtensionOf(schema);
  const arms = [standard?.jsonSchema?.output, standard?.jsonSchema?.input];
  const jsonSchema =
    renderJsonSchemaArm(arms[0], JSON_SCHEMA_TARGET) ??
    renderJsonSchemaArm(arms[1], JSON_SCHEMA_TARGET);
  // Without a rendering there is nothing schema-specific to hash, so the
  // descriptor falls back to vendor and version. That fallback is identical
  // for every schema the vendor produces, which means the changed-`expect`
  // half of the compatibility check cannot fire for this suspension: only
  // the step tail is still covered.
  //
  // The two ways to get here are not equally expected, and the caller is
  // told which. A library with no `jsonSchema` extension at all never had a
  // rendering to lose. A library that OFFERS the extension and then yields
  // nothing has lost one it advertised, and that is worth a word at the park
  // rather than a surprise at the approver's click.
  const degraded =
    jsonSchema === undefined && standard?.jsonSchema !== undefined;
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
    ...(degraded ? { degraded: true } : {}),
  };
}

/**
 * JSON Schema dialect asked of a producer.
 *
 * Standard JSON Schema types both arms as `(options: { target }) => …`, so
 * the argument is required rather than optional: an implementation is
 * entitled to read `options.target` and throw without it. Zod 4 tolerates
 * the omission, which is why calling with no argument looked correct.
 * Pinned rather than configurable, because the value is folded into
 * `continuationHash`: letting it vary would change every stored digest.
 */
const JSON_SCHEMA_TARGET = "draft-2020-12";

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
      if (typeof value === "function") callables[key] = sourceOf(value);
      else config[key] = describable(value);
    }
  }
  return {
    operation: step.operation,
    label: step.label ?? null,
    adapterId: (adapter?.["adapterId"] as string | undefined) ?? null,
    callables,
    config,
    // The own-property walk above only reaches an adapter that keeps its
    // options on itself. Every factory-built adapter returns a role facade
    // (`{ adapterId, subscribe, send, fetch }`) whose slots are bound
    // methods of a delegate holding the options, so its own properties are
    // functions with identical source for every instance: without this,
    // `file({ path: a })` and `file({ path: b })` describe identically.
    // `tagAdapter` already records what the factory was called with, which
    // is the configuration in its most direct form.
    args: (getAdapterArgs(adapter) ?? []).map((arg) => describable(arg)),
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
  if (kind === "symbol") return "[unhashable]";
  // A callback nested in options is a step definition just as much as a
  // top-level adapter callable: `http({ url: (ex) => bankA(ex) })` and the
  // same with `bankB` differ only here. Collapsing it to a placeholder
  // would let the tail's actual target change under a parked approval.
  if (kind === "function") return sourceOf(value as object);
  if (value instanceof Date) return value.toISOString();
  // Carriers an adapter option realistically uses to name its target. Left
  // to the opaque collapse below they would all hash alike, so a payee
  // spelled `new URL(...)` could be edited under a parked approval without
  // moving the digest.
  if (value instanceof URL) return `[url:${value.href}]`;
  if (value instanceof RegExp) return `[regexp:${value.source}/${value.flags}]`;
  // Bound the walk: a deeply nested or self-referential options object must
  // not turn hashing a route into a graph traversal. Above every branch that
  // recurses, collections included, or a cycle through a Map never reaches it.
  if (depth >= 4) return "[deep]";
  if (value instanceof Map) {
    return {
      "[map]": [...value].map(([key, entry]) => [
        describable(key, depth + 1),
        describable(entry, depth + 1),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      "[set]": [...value].map((entry) => describable(entry, depth + 1)),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => describable(entry, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value as object);
  if (prototype !== Object.prototype && prototype !== null) return "[opaque]";
  // Null-prototype accumulator, for the same reason `serialize.ts` uses one:
  // `__proto__` is a genuine own key on anything that came from JSON.parse,
  // and assigning it on an object literal hits the Object.prototype setter,
  // which drops the field. Dropped here it would let a tail option carrying
  // that key change under a parked approval without moving the digest.
  const projected: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = describable(entry, depth + 1);
  }
  return projected;
}

/**
 * A function's source text, verbatim.
 *
 * Deliberately not normalized. See the design rule on
 * {@link continuationHash}: anything that folds two distinct sources onto
 * one digest can only weaken this hash, and the only failure it can produce
 * is the one the hash exists to prevent.
 *
 * @internal
 */
function sourceOf(fn: object): string {
  return Function.prototype.toString.call(fn);
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

/**
 * Digest of a suspension's `stepState` slot, used as the compare half of
 * the store's `replaceStepState` compare-and-swap.
 *
 * A digest rather than the value itself, for two reasons. The slot holds an
 * arbitrarily large blob (an agent's whole message thread is the motivating
 * case), and shipping it back to the store to be compared would double the
 * write. And equality on the blob is only meaningful under a canonical
 * form: the two backends round-trip it through different machinery
 * (`structuredClone` and `JSON.parse`), so key order is not a property a
 * caller can rely on. Hashing the canonical rendering makes the comparison
 * structural.
 *
 * A record with no step state gets its own digest, distinct from one
 * holding `null`, rather than being special-cased at every call site. That
 * makes "the record had no step state" an expectation a caller can hold and
 * lose like any other.
 */
export function stepStateFingerprint(stepState: unknown): string {
  return sha256(
    stepState === undefined
      ? canonical({ absent: true })
      : canonical({ stepState }),
  );
}
