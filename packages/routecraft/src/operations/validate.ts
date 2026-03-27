import { type StandardSchemaV1 } from "@standard-schema/spec";
import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";
import { formatSchemaIssues, rcError } from "../error.ts";

/** Standard Schema validate() result shape: success has value, failure has issues. */
interface StandardSchemaResult {
  value?: unknown;
  issues?: unknown;
}

/**
 * Callable validator function. Receives the full exchange, returns the
 * validated (possibly coerced) body value. Throws on failure.
 *
 * @experimental
 * @template T - Input body type
 * @template R - Output body type (may differ if the validator coerces)
 */
export type CallableValidator<T = unknown, R = T> = (
  exchange: Exchange<T>,
) => R | Promise<R>;

/**
 * Validator adapter: validates the exchange body and returns the validated
 * value. Throws on failure (e.g., RC5002 for schema violations).
 *
 * @experimental
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
 * (error handler if configured, otherwise exchange:failed).
 */
export class ValidateStep<T = unknown, R = T> implements Step<Validator<T, R>> {
  operation: OperationType = OperationType.VALIDATE;
  label?: string;
  adapter: Validator<T, R>;

  constructor(adapter: Validator<T, R> | CallableValidator<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { validate: adapter } : adapter;
  }

  async execute(
    exchange: Exchange,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const result = await Promise.resolve(
      this.adapter.validate(exchange as Exchange<T>),
    );
    exchange.body = result;
    queue.push({ exchange, steps: remainingSteps });
  }
}

/**
 * Creates a Validator adapter from a Standard Schema. On success the
 * validated (possibly coerced) value replaces the exchange body. On
 * failure throws RC5002 with formatted issue details.
 *
 * Use with `.validate(schema(...))` or the `.schema()` sugar method.
 *
 * @experimental
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
      let rawResult = standardSchema["~standard"].validate(exchange.body);
      if (rawResult instanceof Promise) rawResult = await rawResult;
      const result = rawResult as StandardSchemaResult;

      if (result.issues) {
        throw rcError("RC5002", new Error(formatSchemaIssues(result.issues)), {
          message: `Validation failed: ${formatSchemaIssues(result.issues)}`,
        });
      }

      return (
        "value" in result ? result.value : exchange.body
      ) as StandardSchemaV1.InferOutput<S>;
    },
  };
}
