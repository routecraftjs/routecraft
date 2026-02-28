import { type StandardSchemaV1 } from "@standard-schema/spec";
import { FilterStep } from "./filter.ts";
import { OperationType } from "../exchange.ts";
import { error as rcError } from "../error.ts";

/** Standard Schema validate() result shape: success has value, failure has issues. */
interface StandardSchemaResult {
  value?: unknown;
  issues?: unknown;
}

/**
 * Step that validates the exchange body against a Standard Schema.
 * On success, the exchange continues; on failure, throws RC5002 with validation issues.
 * Use with `.validate(schema)`.
 */
export class ValidateStep<T = unknown> extends FilterStep<T> {
  override operation: OperationType = OperationType.VALIDATE;
  constructor(schema: StandardSchemaV1) {
    super(async (exchange) => {
      let rawResult = schema["~standard"].validate(exchange.body);
      if (rawResult instanceof Promise) rawResult = await rawResult;
      const result = rawResult as StandardSchemaResult;

      if (result.issues !== undefined && result.issues !== null) {
        const causeMessage =
          typeof result.issues === "object"
            ? JSON.stringify(result.issues)
            : String(result.issues);
        throw rcError("RC5002", new Error(causeMessage), {
          message: "Validation failed",
        });
      }
      return true;
    });
  }
}
