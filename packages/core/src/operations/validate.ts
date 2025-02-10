import { type StandardSchemaV1 } from "@standard-schema/spec";
import { FilterStep } from "./filter.ts";
import { OperationType } from "../exchange.ts";
import { RouteCraftError, ErrorCode } from "../error.ts";

export class ValidateStep<T = unknown> extends FilterStep<T> {
  override operation: OperationType = OperationType.VALIDATE;
  constructor(schema: StandardSchemaV1) {
    super(async (exchange) => {
      let result = schema["~standard"].validate(exchange.body);
      if (result instanceof Promise) result = await result;

      // if the `issues` field exists, the validation failed
      if (result.issues) {
        const err = RouteCraftError.create(result.issues, {
          code: ErrorCode.VALIDATE_ERROR,
          message: `Error validating exchange ${exchange.id}`,
        });
        exchange.logger.debug(err, `Error validating exchange ${exchange.id}`);
        return false;
      } else {
        return true;
      }
    });
  }
}
