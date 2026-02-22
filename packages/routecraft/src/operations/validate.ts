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
      const issues = (result as { issues?: unknown }).issues;
      if (issues !== undefined && issues !== null) {
        const causeMessage =
          typeof issues === "object" ? JSON.stringify(issues) : String(issues);
        throw rcError("RC5002", new Error(causeMessage), {
          message: "Validation failed",
        });
      }
      return true;
    });
    adapterRef.label = getAdapterLabel(this.adapter);
  }
}
