import { type StandardSchemaV1 } from "@standard-schema/spec";
import { getAdapterLabel } from "../types.ts";
import { FilterStep } from "./filter.ts";
import { OperationType } from "../exchange.ts";
import { error as rcError } from "../error.ts";

export class ValidateStep<T = unknown> extends FilterStep<T> {
  override operation: OperationType = OperationType.VALIDATE;
  constructor(schema: StandardSchemaV1) {
    const adapterRef: { label: string | undefined } = { label: undefined };
    super(async (exchange) => {
      let result = schema["~standard"].validate(exchange.body);
      if (result instanceof Promise) result = await result;

      // if the `issues` field exists, the validation failed
      if (result.issues) {
        const err = rcError("RC5009", result.issues, {
          message: `Error validating exchange ${exchange.id}`,
        });
        const adapterSuffix = adapterRef.label ? ` (${adapterRef.label})` : "";
        exchange.logger.debug(
          adapterRef.label ? { err, adapter: adapterRef.label } : err,
          `Error validating${adapterSuffix} exchange ${exchange.id}`,
        );
        return false;
      } else {
        return true;
      }
    });
    adapterRef.label = getAdapterLabel(this.adapter);
  }
}
