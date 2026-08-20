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
import {
  StepBuilderBase,
  type BuilderState,
  type ExchangeOf,
  type Retyped,
  type SetBody,
  type SetSuspension,
} from "./step-builder-base.ts";
import { PUSH_STEP } from "./dsl-symbol.ts";
import { TapStep } from "./operations/tap.ts";
import { TransformStep, mapper } from "./operations/transform.ts";
import { ValidateStep, schema } from "./operations/validate.ts";
import { log, debug, type LogOptions } from "./adapters/log/index.ts";
import { SuspendStep, type SuspendOptions } from "./operations/suspend.ts";
import {
  ResumeStep,
  type ResumeMapper,
  type ResumeOptions,
} from "./operations/resume.ts";
import type { ResumeAcknowledgment } from "./suspension/revive.ts";

// ---------------------------------------------------------------------------
// registerDsl
// ---------------------------------------------------------------------------

/**
 * Primitive step kinds. Used as documentation in DslRegistration to
 * indicate which core step the sugar delegates to. Not enforced at
 * runtime since the factory creates the step directly.
 */
export type PrimitiveKind =
  "process" | "transform" | "tap" | "filter" | "validate";

/**
 * Registration descriptor for a DSL sugar method.
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
 * so it is available on both `RouteBuilder` and `PathBuilder` (and any
 * future framework-owned subclass).
 *
 * TypeScript types for the new method must be provided separately via
 * module augmentation. Augment `StepBuilderBase<S extends BuilderState>`
 * once (the type parameter list must match the declaration exactly) and
 * both subclasses inherit the method via class-interface inheritance.
 * Type-preserving sugar should return `this`; type-changing sugar should
 * use `Retyped<this, SetBody<S, NewBody>>` so the concrete subclass is
 * preserved across the chain and any future `BuilderState` fields flow
 * through untouched. `StepBuilderBase`, `BuilderState`, `SetBody`, and
 * `Retyped` are exposed as type-only re-exports from the package entry
 * for exactly this purpose.
 *
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
 *   interface StepBuilderBase<S extends BuilderState> {
 *     // Type-preserving: returns `this` (resolves to the concrete subclass)
 *     myStep(opts: MyOpts): this;
 *
 *     // Type-changing variant would look like:
 *     // myMap<Return>(
 *     //   fn: (src: S["body"]) => Return,
 *     // ): Retyped<this, SetBody<S, Return>>;
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
    this: StepBuilderBase<BuilderState>,
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

// `.suspend()` and `.resume()` register here rather than living on
// StepBuilderBase for the same reason `.log()` and `.schema()` do: they are
// one step each with no builder state of their own. They are also
// symmetric, and registering them side by side keeps them that way.
registerDsl("suspend", {
  kind: "process",
  label: "suspend",
  factory: (options: SuspendOptions) => new SuspendStep(options),
});

registerDsl("resume", {
  kind: "process",
  label: "resume",
  factory: (mapper?: ResumeMapper | ResumeOptions, options?: ResumeOptions) =>
    typeof mapper === "function"
      ? new ResumeStep(mapper, options)
      : // `.resume({ keys })` puts the options first; `.resume(undefined,
        // { keys })` is the same door written the long way, and both have to
        // reach the step or a declared channel is silently dropped.
        new ResumeStep(undefined, mapper ?? options),
});

// ---------------------------------------------------------------------------
// Module augmentation: TypeScript types for built-in sugar
// ---------------------------------------------------------------------------

// See .standards/type-safety-and-schemas.md#module-augmentation for why this
// targets the package specifier and not a relative path.
//
// Sugar methods are declared on the shared `StepBuilderBase` interface so
// both `RouteBuilder` and `PathBuilder` inherit them via class-interface
// inheritance. Type-preserving sugars return `this` (polymorphic -- resolves
// to the concrete subclass at the call site); type-changing sugars use
// `Retyped<this, NewT>` (same closed-world conditional the base already uses
// for `.to` / `.transform` / `.enrich`). One declaration, both subclasses
// pick it up.
declare module "@routecraft/routecraft" {
  interface StepBuilderBase<S extends BuilderState> {
    /**
     * Log the current exchange at info level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level defaults to "info")
     */
    log(
      formatter?: (exchange: Exchange<S["body"]>) => unknown,
      options?: LogOptions,
    ): this;

    /**
     * Log the current exchange at debug level. Type-preserving tap.
     *
     * @param formatter - Optional function to format the log output
     * @param options - Optional log options (level is always "debug")
     */
    debug(
      formatter?: (exchange: Exchange<S["body"]>) => unknown,
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
      [K in keyof Return]: (src: S["body"]) => Return[K];
    }): Retyped<this, SetBody<S, Return>>;

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
    schema<Schema extends StandardSchemaV1>(
      standardSchema: Schema,
    ): Retyped<this, SetBody<S, StandardSchemaV1.InferOutput<Schema>>>;

    /**
     * Park the exchange durably and exit the pipeline, to be resumed later
     * at the next step.
     *
     * This run ends here and answers immediately with the `Suspended`
     * acknowledgment, because a durable suspend cannot hold a caller: the
     * answer arrives in hours or days and the process will be restarted
     * first. Nothing is scheduled, no worker waits, and the route stays
     * live for every other exchange. The route's real output flows to its
     * destinations on execution two, when `.resume()` revives the exchange
     * with the answer.
     *
     * The body is unchanged across the park, so a branch that suspends
     * rejoins the main flow with the contract it left on. The answer
     * arrives beside it, on `ex.suspension.result`, typed by `schema`.
     *
     * @param options - `schema` (what a valid answer looks like), a `ttl`
     *   after which the suspension stops being resumable, and who may
     *   answer: an `answer` floor, an `authorize` predicate, and the
     *   channel `key` a `.resume({ keys })` door must serve
     * @example
     * ```ts
     * craft()
     *   .id("payout")
     *   .input({ body: PayoutRequest })
     *   .from(http({ path: "/payouts", method: "POST" }))
     *   .choice(
     *     when((ex) => ex.body.amountCents >= 50_000, (b) =>
     *       b
     *         .tap(direct("notify-approver"))
     *         .suspend({ schema: Approval, ttl: "72h" })
     *         .filter((ex) =>
     *           ex.suspension.result.approved
     *             ? true
     *             : { reason: `rejected by ${ex.suspension.resumedBy?.subject}` },
     *         ),
     *     ),
     *   )
     *   .to(payouts())
     * ```
     */
    suspend<Schema extends StandardSchemaV1>(
      options: SuspendOptions<Schema>,
    ): Retyped<this, SetSuspension<S, StandardSchemaV1.InferOutput<Schema>>>;

    /**
     * Revive a parked exchange and run its continuation.
     *
     * Addresses an EXCHANGE by signed token, not a route by name: any route
     * ending in `.resume()` is a resume ingress, whether it is fed by an
     * HTTP webhook, a mail-reply parser, or an ops CLI. The original source
     * takes no part in execution two, which is what lets a mail-born
     * exchange be continued by a chat-born answer.
     *
     * The mapping function owns SHAPE (find the token, build the candidate
     * answer); validation against the suspending step's `schema` happens at
     * revival, because only the suspension knows that schema. The bare form
     * expects the body to already be `{ token, result }`.
     *
     * Authenticating the answerer belongs on this route: the token proves
     * the deployment minted it, not that its holder may answer. WHO may
     * answer is declared at the suspend site instead, and enforced from the
     * record, so a refusal never burns the rightful answerer's single-use
     * answer; this route supplies the live principal that policy is checked
     * against, and is recorded on the suspension as `resumedBy`. A door
     * exposed publicly wants a `.throttle()` in front of it.
     *
     * The revived route runs to completion before this step continues, so
     * the acknowledgment placed in the body reports how execution two
     * ended, and the ingress route can answer the approver's own channel.
     * A duplicate answer returns the first one's cached terminal outcome
     * without re-running anything.
     *
     * @param map - Maps the ingress exchange to `{ token, result }`
     * @param options - `keys`, the `.suspend({ key })` channels this door
     *   serves. Omitted, it serves every channel.
     * @example
     * ```ts
     * craft()
     *   .id("approval-replies")
     *   .from(mail("INBOX"))
     *   .authenticate(mailPrincipal)
     *   .resume((ex) => ({
     *     token: tokenFrom(ex.headers["routecraft.mail.subject"]),
     *     result: { approved: /^yes/i.test(ex.body.text ?? "") },
     *   }))
     *   .to(log())
     * ```
     */
    resume(
      map?: (
        exchange: ExchangeOf<S>,
        ctx?: { readonly signal?: AbortSignal },
      ) => ReturnType<ResumeMapper<S["body"]>>,
      options?: ResumeOptions,
    ): Retyped<this, SetBody<S, ResumeAcknowledgment>>;
    resume(
      options: ResumeOptions,
    ): Retyped<this, SetBody<S, ResumeAcknowledgment>>;
  }
}
