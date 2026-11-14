import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getAdapterArgs } from "../../adapters/shared/factory-tag.ts";
import {
  DIGEST_EXEMPT,
  NESTED_STEPS,
  STEP_ARGS,
  STEP_IDENTITY,
  STEP_NAME,
  STEP_PLUGIN,
  WRAPPER_IDENTITY,
} from "../../dsl-symbol.ts";
import {
  isStandardSchema,
  renderDirectedJsonSchema,
  ROUTE_SCHEMA_TARGET,
  standardExtensionOf,
} from "../../shared/standard-schema.ts";
import type { Adapter, Step } from "../../types.ts";

/**
 * The key a step, an adapter or a function answers its identity under.
 *
 * A deferred exchange resumes only into the steps it was parked under, and
 * a cache entry replays only for the pipeline that produced it. Both
 * compare a digest of the step definitions, and this is how a definition
 * states what it is. Registered with `Symbol.for`, so an implementation
 * needs no import from this package.
 *
 * ```ts
 * class Approval implements IdentifiedStep {
 *   [IDENTITY]() {
 *     return { kind: "acme.approval", version: 2, options: { quorum: this.quorum } };
 *   }
 * }
 * ```
 */
export const IDENTITY: unique symbol = Symbol.for("routecraft.identity");

/** What a definition says it is. */
export interface Identity {
  /** Stable and namespaced: `routecraft.choice`, `acme.approval`. Never a class name, which a minifier rewrites. */
  readonly kind: string;
  /** Bumped by the author when behaviour changes in a way the options cannot show. */
  readonly version?: string | number;
  /** Everything that configures the behaviour. */
  readonly options?: IdentityValue;
}

/**
 * A value an identity may hold. The canonical encoding gives each carrier
 * its own tag; anything else (a class instance, a native function, a
 * symbol-keyed property) digests as a placeholder and marks the step as
 * inferred, which `RC5071` reports on a route that defers.
 */
export type IdentityValue = unknown;

/** Anything that states its own identity: a step, an adapter, a function a helper returned. */
export interface Identified {
  [IDENTITY](): Identity;
}

/** A step that states its own identity, replacing the one derived from its factory arguments. */
export interface IdentifiedStep extends Step<Adapter>, Identified {}

/** An adapter that states its own identity. `kind` defaults to its `adapterId`. */
export interface IdentifiedAdapter extends Adapter {
  [IDENTITY](): Omit<Identity, "kind"> & { readonly kind?: string };
}

const SECRET: unique symbol = Symbol.for("routecraft.identity.secret");
const VERSIONED: unique symbol = Symbol.for("routecraft.identity.versioned");

/** A value marked by {@link secret}. */
export interface SecretMarker {
  readonly [SECRET]: true;
}

/** A value marked by {@link versioned}. */
export interface VersionedMarker {
  readonly [VERSIONED]: string;
}

/**
 * Mark a value that configures a step without defining it: a token, a
 * password, a signing key. It digests as a constant, so rotating it
 * re-asks no parked approval and misses no cache entry.
 *
 * The value is not kept: the marker stands in for it in an identity only.
 */
export function secret(value: unknown): SecretMarker {
  void value;
  return SECRET_MARKER;
}
const SECRET_MARKER: SecretMarker = Object.freeze({ [SECRET]: true as const });

/**
 * State a value's identity by hand. `id` is digested and the value is not,
 * for a value the encoding cannot see into (a client, a registered
 * resource) whose author knows when it changed.
 */
export function versioned(_value: unknown, id: string): VersionedMarker {
  return Object.freeze({ [VERSIONED]: id });
}

/**
 * Give a function or an object an identity, so the digest reads that and
 * never the source of a function it holds. Every core export that returns
 * a function uses it: core's emitted text differs between the ESM and the
 * CJS build, and what such a function captured is invisible in its source
 * anyway.
 *
 * @internal
 */
export function identified<T extends object>(target: T, identity: Identity): T {
  Object.defineProperty(target, IDENTITY, { value: () => identity });
  return target;
}

/** How deep the encoding follows a value before it gives up on a branch. */
const MAX_DEPTH = 5;

/** Why a step's digest does not cover all of its definition. */
export interface InferredNode {
  /** Where the value sits, e.g. `steps[2].options.client`. */
  readonly path: string;
  /** What the encoding met there. */
  readonly reason: string;
}

interface Walk {
  readonly inferred: InferredNode[];
  readonly ancestors: unknown[];
}

function note(walk: Walk, path: string, reason: string): void {
  walk.inferred.push({ path, reason });
}

function identityOf(value: object): Identity | undefined {
  const answer = (value as Partial<Identified>)[IDENTITY];
  return typeof answer === "function" ? answer.call(value) : undefined;
}

function isAdapterLike(value: object): boolean {
  return (
    typeof (value as { adapterId?: unknown }).adapterId === "string" ||
    getAdapterArgs(value) !== undefined
  );
}

function encodeIdentity(identity: Identity, path: string, walk: Walk): unknown {
  return [
    "id",
    identity.kind,
    identity.version === undefined ? null : String(identity.version),
    encode(identity.options, `${path}.options`, 1, walk),
  ];
}

/**
 * An adapter's definition. One that answers {@link IDENTITY} states it. One
 * a factory built through `tagAdapter` is what the factory was called
 * with: its own properties are bound methods of a delegate, identical for
 * every instance. Any other is its own properties, where a hand-written
 * adapter keeps its callbacks and options.
 */
function encodeAdapter(adapter: object, path: string, walk: Walk): unknown {
  const adapterId = (adapter as { adapterId?: unknown }).adapterId;
  const id = typeof adapterId === "string" ? adapterId : null;
  const stated = identityOf(adapter) as
    (Omit<Identity, "kind"> & { kind?: string }) | undefined;
  if (stated) {
    return encodeIdentity(
      { ...stated, kind: stated.kind ?? id ?? "adapter" },
      path,
      walk,
    );
  }
  const args = getAdapterArgs(adapter);
  if (args !== undefined) {
    return ["adapter", id, encode(args, `${path}.args`, 1, walk)];
  }
  if (typeof adapter === "function") {
    return ["adapter", id, encodeFunction(adapter, path, walk)];
  }
  const own: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(adapter).sort()) {
    if (key === "adapterId") continue;
    own[key] = encode(
      (adapter as Record<string, unknown>)[key],
      `${path}.${key}`,
      1,
      walk,
    );
  }
  return ["adapter", id, own];
}

function encodeFunction(fn: object, path: string, walk: Walk): unknown {
  const stated = identityOf(fn);
  if (stated) return encodeIdentity(stated, path, walk);
  const source = Function.prototype.toString.call(fn);
  if (source.includes("[native code]")) {
    note(walk, path, "a native or bound function");
    return ["fn", "[native]"];
  }
  // Verbatim. Normalising can only fold two sources onto one digest, and a
  // missed change resumes an approval into behaviour nobody authorized.
  return ["fn", source];
}

function encodeSchema(
  schema: StandardSchemaV1,
  path: string,
  walk: Walk,
): unknown {
  const rendered = renderDirectedJsonSchema(
    schema,
    "output",
    ROUTE_SCHEMA_TARGET,
  );
  if (rendered !== undefined) {
    return ["schema", encodeJson(rendered)];
  }
  const standard = standardExtensionOf(schema);
  note(walk, path, "a schema with no JSON Schema rendering");
  return ["schema", standard?.vendor ?? "unknown", "degraded"];
}

/** A JSON Schema rendering is plain JSON, of any depth. */
function encodeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(encodeJson);
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    sorted[key] = encodeJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * The canonical encoding of one value. Every carrier has its own tag, so a
 * number never equals the string that spells it and `undefined` never
 * equals `null`. See `.standards/plugin-architecture.md` for the table.
 */
function encode(
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
): unknown {
  if (value === null) return ["null"];
  switch (typeof value) {
    case "undefined":
      return ["undef"];
    case "string":
      return ["s", value];
    case "boolean":
      return ["b", value];
    case "number":
      if (Number.isNaN(value)) return ["n", "NaN"];
      if (!Number.isFinite(value)) {
        return ["n", value > 0 ? "Infinity" : "-Infinity"];
      }
      return ["n", value === 0 ? 0 : value];
    case "bigint":
      return ["big", value.toString()];
    case "symbol":
      note(walk, path, "a symbol");
      return ["opaque", "symbol"];
    case "function":
      return isAdapterLike(value)
        ? encodeAdapter(value, path, walk)
        : encodeFunction(value, path, walk);
    default:
  }
  const object = value as object;
  if (SECRET in object) return ["secret"];
  if (VERSIONED in object) {
    return ["versioned", (object as VersionedMarker)[VERSIONED]];
  }
  if (object instanceof Date) {
    return [
      "date",
      Number.isNaN(object.getTime()) ? "invalid" : object.toISOString(),
    ];
  }
  if (object instanceof URL) return ["url", object.href];
  if (object instanceof RegExp) return ["re", object.source, object.flags];
  const stated = identityOf(object);
  if (stated && !isAdapterLike(object))
    return encodeIdentity(stated, path, walk);
  if (isStandardSchema(object)) return encodeSchema(object, path, walk);
  if (walk.ancestors.includes(object)) {
    note(walk, path, "a value that contains itself");
    return ["cycle"];
  }
  if (depth > MAX_DEPTH) {
    note(walk, path, `nested more than ${MAX_DEPTH} deep`);
    return ["deep"];
  }
  walk.ancestors.push(object);
  try {
    if (isAdapterLike(object)) return encodeAdapter(object, path, walk);
    if (Array.isArray(object)) {
      return [
        "a",
        object.map((entry, index) =>
          encode(entry, `${path}[${index}]`, depth + 1, walk),
        ),
      ];
    }
    if (object instanceof Map) {
      return [
        "map",
        [...object].map(([key, entry], index) => [
          encode(key, `${path}<key ${index}>`, depth + 1, walk),
          encode(entry, `${path}<value ${index}>`, depth + 1, walk),
        ]),
      ];
    }
    if (object instanceof Set) {
      return [
        "set",
        [...object].map((entry, index) =>
          encode(entry, `${path}<${index}>`, depth + 1, walk),
        ),
      ];
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      note(walk, path, "a class instance");
      const name = (prototype as { constructor?: { name?: unknown } })
        .constructor?.name;
      return ["opaque", typeof name === "string" ? name : null];
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      note(walk, path, "a symbol-keyed property");
    }
    // Null prototype: `__proto__` is a real own key on anything JSON.parse
    // produced, and assigning it on a literal drops the field.
    const projected: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (descriptor.get || descriptor.set) {
        note(walk, `${path}.${key}`, "an accessor");
        projected[key] = ["opaque", "accessor"];
        continue;
      }
      projected[key] = encode(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        walk,
      );
    }
    return ["o", projected];
  } finally {
    walk.ancestors.pop();
  }
}

interface StampedStep {
  [STEP_PLUGIN]?: string;
  [STEP_NAME]?: string;
  [STEP_ARGS]?: readonly unknown[];
  [STEP_IDENTITY]?: Pick<Identity, "version" | "options">;
  [DIGEST_EXEMPT]?: true;
  [NESTED_STEPS]?: () => ReadonlyArray<{
    readonly steps: ReadonlyArray<Step<Adapter>>;
    readonly selector?: IdentityValue;
  }>;
  [WRAPPER_IDENTITY]?: () => Identity & { readonly inner: Step<Adapter> };
}

/**
 * The identity a step has when it states none. A step a plugin's
 * catalogue built is its plugin, its name and the arguments the builder
 * recorded, with its adapter, so nothing the author passed can fall out of
 * the digest by not being restated. Any other step is its operation and
 * its adapter.
 */
function defaultIdentity(step: Step<Adapter> & StampedStep): Identity {
  const plugin = step[STEP_PLUGIN];
  const extra = step[STEP_IDENTITY];
  if (plugin !== undefined) {
    return {
      kind: `${plugin}.${step[STEP_NAME] ?? step.label ?? step.operation}`,
      ...(extra?.version !== undefined ? { version: extra.version } : {}),
      options: {
        args: step[STEP_ARGS] ?? [],
        adapter: step.adapter,
        ...(extra?.options !== undefined ? { extra: extra.options } : {}),
      },
    };
  }
  return { kind: `step.${step.operation}`, options: { adapter: step.adapter } };
}

function encodeStep(
  step: Step<Adapter> & StampedStep,
  path: string,
  walk: Walk,
): unknown {
  const wrapper = step[WRAPPER_IDENTITY]?.call(step);
  if (wrapper) {
    return [
      "wrap",
      wrapper.kind,
      wrapper.version === undefined ? null : String(wrapper.version),
      encode(wrapper.options, `${path}.${wrapper.kind}`, 1, walk),
      encodeStep(wrapper.inner, path, walk),
    ];
  }
  const identity = identityOf(step) ?? defaultIdentity(step);
  const nested = step[NESTED_STEPS]?.call(step) ?? [];
  return [
    "step",
    identity.kind,
    identity.version === undefined ? null : String(identity.version),
    step.label ?? null,
    encode(identity.options, `${path}.options`, 1, walk),
    nested.map((branch, index) => [
      encode(branch.selector, `${path}.branch[${index}].selector`, 1, walk),
      encodeSteps(branch.steps, `${path}.branch[${index}]`, walk),
    ]),
  ];
}

function encodeSteps(
  steps: ReadonlyArray<Step<Adapter>>,
  path: string,
  walk: Walk,
): unknown[] {
  const nodes: unknown[] = [];
  steps.forEach((step, index) => {
    if ((step as StampedStep)[DIGEST_EXEMPT] === true) return;
    nodes.push(encodeStep(step, `${path}[${index}]`, walk));
  });
  return nodes;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The digest format. A stored digest without it predates the identity protocol. */
export const DIGEST_PREFIX = "d2:";

/** What one walk over a list of steps found. */
export interface StepsDescription {
  /** `d2:` and the SHA-256 of the canonical encoding of the steps and `extra`. */
  readonly digest: string;
  /** One digest per step that is not exempt, in order: which step differs, without storing the steps. */
  readonly stepDigests: readonly string[];
  /** The kind of each of those steps, for a message that names the one that moved. */
  readonly kinds: readonly string[];
  /** Every value the digest could not see into. Empty when the digest covers the whole definition. */
  readonly inferred: readonly InferredNode[];
}

/**
 * Describe a list of steps: the one walk the continuation digest and both
 * cache fingerprints read, so the three cannot disagree about what a step
 * is.
 *
 * @param steps - The steps, wrappers and nested branches included
 * @param extra - Anything else the digest binds, as plain data
 *
 * @internal
 */
export function describeSteps(
  steps: ReadonlyArray<Step<Adapter>>,
  extra?: Readonly<Record<string, string | undefined>>,
): StepsDescription {
  const walk: Walk = { inferred: [], ancestors: [] };
  const nodes = encodeSteps(steps, "steps", walk);
  const bound: Record<string, string> = Object.create(null);
  for (const key of Object.keys(extra ?? {}).sort()) {
    const value = extra![key];
    if (value !== undefined) bound[key] = value;
  }
  return {
    digest: DIGEST_PREFIX + sha256(JSON.stringify([nodes, bound])),
    stepDigests: nodes.map((node) => sha256(JSON.stringify(node)).slice(0, 8)),
    kinds: nodes.map((node) => String((node as unknown[])[1])),
    inferred: walk.inferred,
  };
}

/**
 * The digest of {@link describeSteps} alone.
 *
 * @internal
 */
export function stepsDigest(
  steps: ReadonlyArray<Step<Adapter>>,
  extra?: Readonly<Record<string, string | undefined>>,
): string {
  return describeSteps(steps, extra).digest;
}

/**
 * The canonical encoding of one value, as a string. For a test that pins
 * an encoding rule and for a digest of a value that is not a step.
 *
 * @internal
 */
export function encodeIdentityValue(value: IdentityValue): {
  readonly encoded: string;
  readonly inferred: readonly InferredNode[];
} {
  const walk: Walk = { inferred: [], ancestors: [] };
  const encoded = JSON.stringify(encode(value, "value", 1, walk));
  return { encoded, inferred: walk.inferred };
}

/**
 * The canonical encoding of a list of steps, as a string: what
 * {@link describeSteps} hashes. For a test that looks for what reached the
 * digest.
 *
 * @internal
 */
export function encodeStepsCanonical(
  steps: ReadonlyArray<Step<Adapter>>,
): string {
  return JSON.stringify(
    encodeSteps(steps, "steps", { inferred: [], ancestors: [] }),
  );
}
