import { type StandardSchemaV1 } from "@standard-schema/spec";
import { FilterStep } from "./filter.ts";
import { OperationType } from "../exchange.ts";
import { formatSchemaIssues } from "../error.ts";

/** Standard Schema validate() result shape: success has value, failure has issues. */
interface StandardSchemaResult {
  value?: unknown;
  issues?: unknown;
}

/**
 * Step that validates the exchange body against a Standard Schema.
 * On success the exchange continues; on failure the exchange is dropped
 * with a reason describing which fields failed validation.
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
        return {
          reason: `validation failed: ${formatSchemaIssues(result.issues)}`,
        };
      }
      return true;
    });
  }
}
