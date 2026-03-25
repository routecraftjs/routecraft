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
import { RouteBuilder } from "./builder.ts";
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
 */
export type PrimitiveKind =
  | "process"
  | "transform"
  | "tap"
  | "filter"
  | "validate";

/** Registration descriptor for a DSL sugar method. */
export interface DslRegistration {
  /** The core primitive step kind this DSL method delegates to. */
  kind: PrimitiveKind;
  /** Display label shown in traces, logs, and step events. */
  label: string;
  /** Factory that receives the user's call-site arguments and returns a Step. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (...args: any[]) => Step<Adapter>;
}

/**
 * Register a sugar method on RouteBuilder that delegates to a core
 * primitive step type. The method is added to the prototype and is
 * available on all RouteBuilder instances.
 *
 * TypeScript types for the new method must be provided separately via
 * module augmentation (see below for built-in examples).
 *
 * @param name - Method name to add to RouteBuilder
 * @param registration - Kind, label, and factory for the sugar method
 * @throws If a method with the given name already exists on RouteBuilder
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
 *   interface RouteBuilder<Current> {
 *     myStep(opts: MyOpts): RouteBuilder<Current>;
 *   }
 * }
 * ```
 */
export function registerDsl(name: string, registration: DslRegistration): void {
  if (name in RouteBuilder.prototype) {
    throw new Error(
      `Cannot register DSL method "${name}": already exists on RouteBuilder`,
    );
  }

  const { label, factory } = registration;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (RouteBuilder.prototype as Record<string, any>)[name] = function (
    this: RouteBuilder<unknown>,
    ...args: unknown[]
  ) {
    const step = factory(...args);
    step.label = label;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)[PUSH_STEP](step);
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

declare module "./builder.ts" {
  interface RouteBuilder<Current> {
    /**
     * Log the current exchange at info level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level defaults to "info")
     */
    log(
      formatter?: (exchange: Exchange<Current>) => unknown,
      options?: LogOptions,
    ): RouteBuilder<Current>;

    /**
     * Log the current exchange at debug level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level is always "debug")
     */
    debug(
      formatter?: (exchange: Exchange<Current>) => unknown,
      options?: Omit<LogOptions, "level">,
    ): RouteBuilder<Current>;

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
    map<Return>(
      fieldMappings: Record<
        keyof Return,
        (src: Current) => Return[keyof Return]
      >,
    ): RouteBuilder<Return>;

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
    ): RouteBuilder<StandardSchemaV1.InferOutput<S>>;
  }
}
