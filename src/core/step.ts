import { OperationType } from "./exchange.ts";
import { type Destination, type Source } from "./adapter.ts";
import { type Processor } from "./processor.ts";

export type StepDefinition = {
  operation: OperationType;
};

export type FromStepDefinition = StepDefinition & Source;
export type ToStepDefinition = StepDefinition & Destination;
export type ProcessStepDefinition = StepDefinition & Processor;
