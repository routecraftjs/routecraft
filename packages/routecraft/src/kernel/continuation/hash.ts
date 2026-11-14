import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Adapter, Step } from "../../types.ts";
import {
  renderDirectedJsonSchema,
  standardExtensionOf,
} from "../../shared/standard-schema.ts";
import type { SerializedExchange, DeferralSchema } from "./types.ts";
import {
  describeSteps,
  DIGEST_PREFIX,
  type StepsDescription,
} from "./identity.ts";

/**
 * Describe the continuation of a deferred exchange: the steps that have
 * NOT run yet, plus the schema the resume payload is validated against.
 *
 * ## Why the tail and not the pipeline
 *
 * Steps before the defer point already ran. Changing one cannot affect
 * what happens after resume, so including them would invalidate every
 * approval in flight on any deploy that touched the route. Hashing the
 * tail keeps the property worth keeping (a change to what the approval
 * authorizes invalidates it) and drops the one that made it unusable.
 *
 * ## What the digest covers
 *
 * Step definitions only, as each step states them (`IDENTITY`) or as the
 * builder recorded them. Framework code is never digested by its source
 * text. A user's function is, verbatim: normalising it can only fold two
 * sources onto one digest, and a missed change resumes an approval into
 * behaviour its approver never authorized, while a spurious one costs a
 * re-ask.
 *
 * ## What it does not cover
 *
 * What a function captured, what a `direct()` target or a registered
 * resource does, an environment variable, and any value the encoding
 * could not see into (reported as `inferred`, and warned about at start
 * with `RC5071`). A runtime or transpiler change that alters a function's
 * text, or a schema library that renders its JSON Schema differently,
 * moves the digest without a behaviour change: a re-ask, never a wrong
 * resume.
 *
 * @param tail - Exactly what a resume would run: the steps after a
 *   `.defer()`, or for a re-entrant site the deferring step first
 * @param schema - The resume-payload schema descriptor
 * @param errorPath - The origin of an error-path park, bound so a store
 *   that drops it cannot hand the resume to a defer site at the same
 *   position
 *
 * @internal
 */
export function describeContinuation(
  tail: ReadonlyArray<Step<Adapter>>,
  schema: DeferralSchema,
  errorPath?: string,
): StepsDescription {
  return describeSteps(tail, { input: schema.hash, errorPath });
}

/**
 * What a deferral stores of its continuation: the digest, then one short
 * digest per tail step after a `/`. Two continuations are the same when
 * the strings are equal. The per-step part adds nothing to that test (the
 * digest already covers every step); it is there so a refused resume can
 * say which step moved without the record storing the steps.
 *
 * @internal
 */
export function continuationTailHash(
  tail: ReadonlyArray<Step<Adapter>>,
  schema: DeferralSchema,
  errorPath?: string,
): string {
  const described = describeContinuation(tail, schema, errorPath);
  return `${described.digest}/${described.stepDigests.join(".")}`;
}

/**
 * Whether a stored continuation hash is in the current format. One that
 * is not was written before steps stated their identity and cannot be
 * compared with anything computed now.
 *
 * @internal
 */
export function isCurrentContinuationHash(stored: string): boolean {
  return stored.startsWith(DIGEST_PREFIX);
}

/**
 * Say what differs between a stored continuation and the live one, for the
 * refusal a changed continuation raises.
 *
 * @param stored - The record's `continuationHash`
 * @param tail - The live continuation
 * @returns A clause naming the first step that differs, or the resume
 *   schema when every step matches
 *
 * @internal
 */
export function continuationDifference(
  stored: string,
  tail: ReadonlyArray<Step<Adapter>>,
  schema: DeferralSchema,
  errorPath?: string,
): string {
  const live = describeContinuation(tail, schema, errorPath);
  const slash = stored.indexOf("/");
  const before =
    slash < 0
      ? []
      : stored
          .slice(slash + 1)
          .split(".")
          .filter(Boolean);
  const index = live.stepDigests.findIndex((digest, i) => digest !== before[i]);
  if (index >= 0) {
    return `step ${index + 1} of what would run (${live.kinds[index]}) differs`;
  }
  if (before.length > live.stepDigests.length) {
    return `${before.length - live.stepDigests.length} step(s) were removed from the end`;
  }
  return "the schema the resume payload is validated against differs";
}

/**
 * Describe the expected-result schema for storage and hashing.
 *
 * The schema itself is a live object with a validate function, so it cannot
 * be persisted. What is persisted is this descriptor: a hash that folds
 * into {@link continuationHash} so a schema changed under a deferred exchange
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
 * `renderJsonSchemaArm` resolves either. Storing the unresolved function instead would be
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
 * @param schema - The `schema` declared on `.defer()`, if any.
 * @returns A serializable descriptor of the schema.
 *
 * @internal
 */
export function describeSchema(schema?: StandardSchemaV1): DeferralSchema {
  if (!schema) {
    return { hash: sha256(canonical({ absent: true })), absent: true };
  }
  const standard = standardExtensionOf(schema);
  const jsonSchema = renderDirectedJsonSchema(
    schema,
    "output",
    JSON_SCHEMA_TARGET,
  );
  // Without a rendering there is nothing schema-specific to hash, so the
  // descriptor falls back to vendor and version. That fallback is identical
  // for every schema the vendor produces, which means the changed-`expect`
  // half of the compatibility check cannot fire for this deferral: only
  // the step tail is still covered.
  //
  // The two ways to get here are not equally expected, and the caller is
  // told which. A library with no `jsonSchema` extension at all never had a
  // rendering to lose. A library that OFFERS the extension and then yields
  // nothing has lost one it advertised, and that is worth a word at the deferral
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
 * Without this, a receipt says "someone approved deferral abc123". With
 * it, the receipt says "this principal authorized this exact operation on
 * this exact payload". It costs one hash and turns the audit trail from a
 * reference into evidence.
 *
 * This is audit-grade binding, not a second access control: the frozen
 * exchange already stops payload tampering, and `continuationHash` already
 * catches a changed continuation.
 *
 * @param input - Route identity, defer position, the continuation hash,
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
 * Deterministic JSON with object keys sorted at every depth, so two
 * structurally equal values always hash to the same digest regardless of
 * insertion order.
 *
 * @internal
 */
function canonical(value: unknown): string {
  // Not JSON's `null`: a step factory may act differently on `f(undefined)`
  // and `f(null)`, and a deferred approval must not resume under the other.
  if (value === undefined) return '"[undefined]"';
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
 * Digest of a deferral's `stepState` slot, used as the compare half of
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
