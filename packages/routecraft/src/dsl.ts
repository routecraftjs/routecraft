/**
 * DSL registration system for RouteBuilder sugar methods.
 *
 * Built-in sugar (.log, .debug, .map, .schema) is registered at module
 * scope so it is available as soon as anything is imported from the
 * package. External packages follow the same pattern: import their
 * index, and their sugar is registered automatically.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Adapter, Step } from "./types.ts";
import type { Exchange } from "./exchange.ts";
import { StepBuilderBase, type Retyped } from "./step-builder-base.ts";
import { PUSH_STEP } from "./dsl-symbol.ts";
import { TapStep } from "./operations/tap.ts";
import { TransformStep, mapper } from "./operations/transform.ts";
import { ValidateStep, schema } from "./operations/validate.ts";
import { log, debug, type LogOptions } from "./adapters/log/index.ts";

// ---------------------------------------------------------------------------
// registerDsl
// ---------------------------------------------------------------------------

/**
 * Primitive step kinds. Used as documentation in DslRegistration to
 * indicate which core step the sugar delegates to. Not enforced at
 * runtime since the factory creates the step directly.
 *
 * @experimental
 */
export type PrimitiveKind =
  | "process"
  | "transform"
  | "tap"
  | "filter"
  | "validate";

/**
 * Registration descriptor for a DSL sugar method.
 *
 * @experimental
 */
export interface DslRegistration {
  /** The core primitive step kind this DSL method delegates to. */
  kind: PrimitiveKind;
  /** Display label shown in traces, logs, and step events. */
  label: string;
  /** Factory that receives the user's call-site arguments and returns a Step. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- factory must accept arbitrary call-site args; actual types come from module augmentation
  factory: (...args: any[]) => Step<Adapter>;
}

/**
 * Register a sugar method on `StepBuilderBase` that delegates to a core
 * primitive step type. The method is added to the shared base prototype
 * so it is available on both `RouteBuilder` and `BranchBuilder` (and any
 * future framework-owned subclass).
 *
 * TypeScript types for the new method must be provided separately via
 * module augmentation. Augment `StepBuilderBase<Current>` once and both
 * subclasses inherit the method via class-interface inheritance. Type-
 * preserving sugar should return `this`; type-changing sugar should use
 * `Retyped<this, NewT>` so the concrete subclass is preserved across the
 * chain. `StepBuilderBase` and `Retyped` are exposed as type-only
 * re-exports from the package entry for exactly this purpose.
 *
 * @experimental
 * @param name - Method name to add to the shared base prototype
 * @param registration - Kind, label, and factory for the sugar method
 * @throws If a method with the given name already exists on the base
 *
 * @example
 * ```ts
 * registerDsl("myStep", {
 *   kind: "tap",
 *   label: "myStep",
 *   factory: (opts) => new TapStep(myAdapter(opts)),
 * });
 *
 * declare module "@routecraft/routecraft" {
 *   interface StepBuilderBase<Current> {
 *     // Type-preserving: returns `this` (resolves to the concrete subclass)
 *     myStep(opts: MyOpts): this;
 *
 *     // Type-changing variant would look like:
 *     // myMap<Return>(fn: (src: Current) => Return): Retyped<this, Return>;
 *   }
 * }
 * ```
 */
export function registerDsl(name: string, registration: DslRegistration): void {
  if (name in StepBuilderBase.prototype) {
    throw new Error(
      `Cannot register DSL method "${name}": already exists on StepBuilderBase`,
    );
  }

  const { label, factory } = registration;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic prototype patching requires indexing with a string key
  (StepBuilderBase.prototype as Record<string, any>)[name] = function (
    this: StepBuilderBase<unknown>,
    ...args: unknown[]
  ) {
    const step = factory(...args);
    step.label = label;
    this[PUSH_STEP](step);
    return this;
  };
}

// ---------------------------------------------------------------------------
// Built-in sugar registrations (run at import time)
// ---------------------------------------------------------------------------

registerDsl("log", {
  kind: "tap",
  label: "log",
  factory: (
    formatter?: (exchange: Exchange<unknown>) => unknown,
    options?: LogOptions,
  ) => new TapStep(log(formatter, options)),
});

registerDsl("debug", {
  kind: "tap",
  label: "debug",
  factory: (
    formatter?: (exchange: Exchange<unknown>) => unknown,
    options?: Omit<LogOptions, "level">,
  ) => new TapStep(debug(formatter, options)),
});

registerDsl("map", {
  kind: "transform",
  label: "map",
  factory: (fieldMappings: Record<string, (src: unknown) => unknown>) =>
    new TransformStep(mapper(fieldMappings)),
});

registerDsl("schema", {
  kind: "validate",
  label: "schema",
  factory: (standardSchema: StandardSchemaV1) =>
    new ValidateStep(schema(standardSchema)),
});

// ---------------------------------------------------------------------------
// Module augmentation: TypeScript types for built-in sugar
// ---------------------------------------------------------------------------

// See .standards/type-safety-and-schemas.md#module-augmentation for why this
// targets the package specifier and not a relative path.
//
// Sugar methods are declared on the shared `StepBuilderBase` interface so
// both `RouteBuilder` and `BranchBuilder` inherit them via class-interface
// inheritance. Type-preserving sugars return `this` (polymorphic -- resolves
// to the concrete subclass at the call site); type-changing sugars use
// `Retyped<this, NewT>` (same closed-world conditional the base already uses
// for `.to` / `.transform` / `.enrich`). One declaration, both subclasses
// pick it up.
declare module "@routecraft/routecraft" {
  interface StepBuilderBase<Current> {
    /**
     * Log the current exchange at info level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level defaults to "info")
     */
    log(
      formatter?: (exchange: Exchange<Current>) => unknown,
      options?: LogOptions,
    ): this;

    /**
     * Log the current exchange at debug level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level is always "debug")
     */
    debug(
      formatter?: (exchange: Exchange<Current>) => unknown,
      options?: Omit<LogOptions, "level">,
    ): this;

    /**
     * Map fields from the current data to create a new object. Sugar
     * for `.transform(mapper({...}))`.
     *
     * @template Return - The resulting type after mapping
     * @param fieldMappings - Object mapping output field names to extractor functions
     * @example
     * ```ts
     * .map<DbUser>({
     *   id: (apiUser) => apiUser.userId,
     *   name: (apiUser) => apiUser.fullName,
     * })
     * ```
     */
    map<Return>(fieldMappings: {
      [K in keyof Return]: (src: Current) => Return[K];
    }): Retyped<this, Return>;

    /**
     * Validate the exchange body against a Standard Schema. Sugar for
     * `.validate(schema(standardSchema))`. On failure throws RC5002.
     *
     * @param standardSchema - Any Standard Schema v1 (Zod, Valibot, ArkType, etc.)
     * @example
     * ```ts
     * import { z } from "zod";
     * craft()
     *   .from(source)
     *   .schema(z.object({ name: z.string() }))
     *   .to(dest)
     * ```
     */
    schema<S extends StandardSchemaV1>(
      standardSchema: S,
    ): Retyped<this, StandardSchemaV1.InferOutput<S>>;
  }
}
