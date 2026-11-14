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
 * inferred, which `RC5071` reports on a route that defers. Deliberately
 * `unknown`: a class instance is a plain object to the type system, so a
 * narrower type would reject nothing the encoding does not already report.
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

const SECRET_MARKER: SecretMarker = Object.freeze({ [SECRET]: true as const });

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
 * a function uses it, and so should any helper that returns one: what a
 * closure captured is invisible in its source, so `guard({ roles })` reads
 * the same for every `roles` until it is identified.
 */
export function identified<T extends object>(target: T, identity: Identity): T {
  Object.defineProperty(target, IDENTITY, {
    value: () => identity,
    configurable: true,
  });
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
  if (hasClassMethods(adapter)) {
    note(walk, path, "an adapter whose methods live on its class");
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

/** Whether behaviour sits on the prototype chain, where own properties do not show it. */
function hasClassMethods(value: object): boolean {
  for (
    let proto: object | null = Object.getPrototypeOf(value);
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (
      Object.getOwnPropertyNames(proto).some((key) => key !== "constructor")
    ) {
      return true;
    }
  }
  return false;
}

function encodeFunction(fn: object, path: string, walk: Walk): unknown {
  const stated = identityOf(fn);
  if (stated) {
    return inside(fn, path, walk, () => encodeIdentity(stated, path, walk));
  }
  const source = Function.prototype.toString.call(fn);
  if (/\{\s*\[native code\]\s*\}\s*$/.test(source)) {
    note(walk, path, "a native or bound function");
    return ["fn", "[native]"];
  }
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
    DIGEST_SCHEMA_TARGET,
  );
  if (rendered !== undefined) {
    return ["schema", encodeJson(rendered)];
  }
  const standard = standardExtensionOf(schema);
  note(walk, path, "a schema with no JSON Schema rendering");
  return ["schema", standard?.vendor ?? "unknown", standard?.version ?? 0];
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
        ? inside(value, path, walk, () => encodeAdapter(value, path, walk))
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
  if (stated && !isAdapterLike(object)) {
    return inside(object, path, walk, () => encodeIdentity(stated, path, walk));
  }
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
    readonly rejoins?: boolean;
    readonly selector?: IdentityValue;
  }>;
  [WRAPPER_IDENTITY]?: () => Identity & { readonly inner: Step<Adapter> };
}

/** The kind of a step that states none: its plugin and name when a catalogue built it, its operation otherwise. */
function defaultKind(step: Step<Adapter> & StampedStep): string {
  const plugin = step[STEP_PLUGIN];
  return plugin === undefined
    ? `step.${step.operation}`
    : `${plugin}.${step[STEP_NAME] ?? step.label ?? step.operation}`;
}

/**
 * Run `encodeInside` with `holder` on the ancestor stack, so an identity
 * whose options lead back to the value that states it ends as a cycle. The
 * holder is what repeats: `[IDENTITY]()` builds a fresh options object on
 * every call.
 */
function inside(
  holder: object,
  path: string,
  walk: Walk,
  encodeInside: () => unknown,
): unknown {
  if (walk.ancestors.includes(holder)) {
    note(walk, path, "a value that contains itself");
    return ["cycle"];
  }
  walk.ancestors.push(holder);
  try {
    return encodeInside();
  } finally {
    walk.ancestors.pop();
  }
}

/**
 * A step's kind, version and encoded options. A step that states no
 * identity is its adapter, and for one a plugin's catalogue built also the
 * arguments the builder recorded, so nothing the author passed falls out
 * of the digest by not being restated. Over either lies what
 * `step(impl, { identity })` stated: the version replaces
 * the version, and the options replace the derived arguments (or the
 * options the step stated itself). The adapter of a derived identity
 * stays, so the callback is never restated.
 *
 * Each argument starts its own depth budget: the levels this function adds
 * around the author's values are not the author's nesting.
 */
function encodeStepIdentity(
  step: Step<Adapter> & StampedStep,
  path: string,
  walk: Walk,
): { kind: string; version: string | null; options: unknown } {
  const stated = identityOf(step);
  const over = step[STEP_IDENTITY];
  const version = over?.version ?? stated?.version;
  const at = `${path}.options`;
  let options: unknown;
  if (stated) {
    options = encode(
      over?.options !== undefined ? over.options : stated.options,
      at,
      1,
      walk,
    );
  } else {
    const derived: Record<string, unknown> = Object.create(null);
    derived["adapter"] = encode(step.adapter, `${at}.adapter`, 1, walk);
    if (over?.options !== undefined) {
      derived["stated"] = encode(over.options, `${at}.stated`, 1, walk);
    } else if (step[STEP_PLUGIN] !== undefined) {
      derived["args"] = [
        "a",
        (step[STEP_ARGS] ?? []).map((arg, index) =>
          encode(arg, `${at}.args[${index}]`, 1, walk),
        ),
      ];
    }
    options = ["o", derived];
  }
  return {
    kind: stated?.kind ?? defaultKind(step),
    version: version === undefined ? null : String(version),
    options,
  };
}

interface EncodedStep {
  readonly kind: string;
  readonly node: unknown;
}

function encodeStep(
  step: Step<Adapter> & StampedStep,
  path: string,
  walk: Walk,
): EncodedStep {
  const wrapper = step[WRAPPER_IDENTITY]?.call(step);
  if (wrapper) {
    return {
      kind: wrapper.kind,
      node: inside(step, path, walk, () => [
        "wrap",
        wrapper.kind,
        wrapper.version === undefined ? null : String(wrapper.version),
        encode(wrapper.options, `${path}.${wrapper.kind}`, 1, walk),
        encodeStep(wrapper.inner, path, walk).node,
      ]),
    };
  }
  let kind = `step.${step.operation}`;
  const node = inside(step, path, walk, () => {
    const identity = encodeStepIdentity(step, path, walk);
    kind = identity.kind;
    const nested = step[NESTED_STEPS]?.call(step) ?? [];
    return [
      "step",
      identity.kind,
      identity.version,
      step.label ?? null,
      identity.options,
      nested.map((branch, index) => [
        encode(branch.selector, `${path}.branch[${index}].selector`, 1, walk),
        branch.rejoins === true,
        encodeSteps(branch.steps, `${path}.branch[${index}]`, walk).map(
          (encoded) => encoded.node,
        ),
      ]),
    ];
  });
  return { kind, node };
}

function encodeSteps(
  steps: ReadonlyArray<Step<Adapter>>,
  path: string,
  walk: Walk,
): Array<EncodedStep & { readonly position: number }> {
  const encoded: Array<EncodedStep & { readonly position: number }> = [];
  steps.forEach((step, index) => {
    if ((step as StampedStep)[DIGEST_EXEMPT] === true) return;
    encoded.push({
      ...encodeStep(step, `${path}[${index}]`, walk),
      position: index,
    });
  });
  return encoded;
}

/**
 * The JSON Schema dialect a schema is rendered in before it is digested.
 * Pinned: it is folded into stored digests, so it never follows the
 * dialect the ops surface or `craft run --help` describes a route in.
 *
 * @internal
 */
export const DIGEST_SCHEMA_TARGET = "draft-2020-12";

/** @internal */
export function sha256(input: string): string {
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
  /** Where each of those steps sits in the list given, exempt steps counted. */
  readonly positions: readonly number[];
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
  const encoded = encodeSteps(steps, "steps", walk);
  const nodes = encoded.map((step) => step.node);
  const bound: Record<string, string> = Object.create(null);
  for (const key of Object.keys(extra ?? {}).sort()) {
    const value = extra![key];
    if (value !== undefined) bound[key] = value;
  }
  return {
    digest: DIGEST_PREFIX + sha256(JSON.stringify([nodes, bound])),
    stepDigests: nodes.map((node) => sha256(JSON.stringify(node)).slice(0, 8)),
    kinds: encoded.map((step) => step.kind),
    positions: encoded.map((step) => step.position),
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
    encodeSteps(steps, "steps", { inferred: [], ancestors: [] }).map(
      (step) => step.node,
    ),
  );
}
