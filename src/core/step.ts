import { OperationType } from "./exchange.ts";
import { Destination, Source } from "./adapter.ts";
import { Processor } from "./processor.ts";

export type StepDefinition = {
  operation: OperationType;
};

export type FromStepDefinition = StepDefinition & Source;
export type ToStepDefinition = StepDefinition & Destination;
export type ProcessStepDefinition = StepDefinition & Processor;
