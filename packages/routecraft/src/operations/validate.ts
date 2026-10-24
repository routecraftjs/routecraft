import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Adapter, Step, StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  DefaultExchange,
  routeIdOf,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import {
  isRefusal,
  refusalError,
  STEP_REFUSAL_SLOT,
  type Refusal,
} from "../kernel/hooks.ts";
import { validateAgainst } from "../pipeline/validation.ts";

/**
 * Callable validator function. Receives the full exchange and returns the
 * validated (possibly coerced) body value. Throws on a failure that is the
 * instance's; returns or throws a {@link Refusal} built with `refuse()`
 * to refuse the caller with a reason a door forwards.
 *
 * @template T - Input body type
 * @template R - Output body type (may differ if the validator coerces)
 */
export type CallableValidator<
  T = unknown,
  R = T,
  Ex extends Exchange<T> = Exchange<T>,
> = (exchange: Ex) => R | Refusal | Promise<R | Refusal>;

/**
 * The body a `.validate()` step carries on: what the validator returns, less
 * the refusal it may answer instead. A validator that can only refuse leaves
 * the body as it was, since nothing after the step ever runs on its answer.
 * One that never returns, because every path throws, carries `never`, so a
 * branch ending in it fits any `.choice()` result type.
 *
 * @template Current - The body before the step
 * @template R - The validator's return type
 */
export type Validated<Current, R> = [R] extends [never]
  ? never
  : [Exclude<R, Refusal>] extends [never]
    ? Current
    : Exclude<R, Refusal>;

/**
 * Validator adapter: validates the exchange body and returns the validated
 * value. Throws on a failure that is the instance's (e.g., RC5002 for
 * schema violations); returns or throws a {@link Refusal} to refuse the
 * caller.
 *
 * @template T - Input body type
 * @template R - Output body type
 */
export interface Validator<T = unknown, R = T> extends Adapter {
  validate: CallableValidator<T, R>;
}

/**
 * Step that validates the exchange body using a Validator adapter.
 * On success the exchange continues with the (possibly coerced) body.
 * On failure the adapter throws and the normal error path handles it
 * (error handler if configured, otherwise route:exchange:failed).
 *
 * A validator that returns or throws a `Refusal` fails the run with
 * `RC5068` bound to this exchange's route, exactly as a validate hook's
 * refusal is, so a door that dispatched the route answers the caller with
 * the kind and the reason, and one raised inside a nested `direct()` call
 * stays the instance's. A validator cannot hand a refusal on as the body:
 * the brand is checked before the body is replaced.
 */
export class ValidateStep<T = unknown, R = T> implements Step<Validator<T, R>> {
  operation: OperationType = OperationType.VALIDATE;
  label?: string;
  adapter: Validator<T, R>;

  constructor(adapter: Validator<T, R> | CallableValidator<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { validate: adapter } : adapter;
  }

  async execute(exchange: Exchange): Promise<StepOutcome> {
    let result: R | Refusal;
    try {
      result = await Promise.resolve(
        this.adapter.validate(exchange as Exchange<T>),
      );
    } catch (error) {
      if (isRefusal(error)) throw this.refusalError(exchange, error);
      throw error;
    }
    if (isRefusal(result)) throw this.refusalError(exchange, result);
    return {
      kind: "continue",
      exchange: DefaultExchange.rewrap<R>(exchange, { body: result }),
    };
  }

  /**
   * The `RC5068` for a refusal this step raised, bound to the route the
   * exchange runs on.
   */
  private refusalError(exchange: Exchange, refusal: Refusal): Error {
    const step = this.label ?? "validate";
    return refusalError(
      {
        origin: "step",
        hook: step,
        slot: STEP_REFUSAL_SLOT,
        routeId: routeIdOf(exchange),
        kind: refusal.kind,
        reason: refusal.reason,
      },
      `The ${step} step refused the exchange (${refusal.kind}): ${refusal.reason}`,
    );
  }
}

/**
 * Creates a Validator adapter from a Standard Schema. On success the
 * validated (possibly coerced) value replaces the exchange body. On
 * failure throws RC5002 with formatted issue details.
 *
 * Use with `.validate(schema(...))` or the `.schema()` sugar method.
 *
 * @param standardSchema - Any Standard Schema v1 implementation (Zod, Valibot, ArkType, etc.)
 * @returns A Validator adapter that throws RC5002 on failure
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * craft()
 *   .from(source)
 *   .validate(schema(z.object({ name: z.string() })))
 *   .to(dest)
 * ```
 */
export function schema<S extends StandardSchemaV1>(
  standardSchema: S,
): Validator<unknown, StandardSchemaV1.InferOutput<S>> {
  return {
    validate: async (exchange) => {
      const result = await validateAgainst(standardSchema, exchange.body);
      if (!result.ok) {
        throw rcError("RC5002", new Error(result.message), {
          message: `Validation failed: ${result.message}`,
        });
      }
      return result.value;
    },
  };
}
