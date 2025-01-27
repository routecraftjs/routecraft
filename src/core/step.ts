import { OperationType } from "./exchange.ts";
import { type Destination, type Processor, type Source } from "./adapter.ts";

export type StepDefinition = {
  operation: OperationType;
};

export type FromStepDefinition = StepDefinition & Source;
export type ToStepDefinition = StepDefinition & Destination;
export type ProcessStepDefinition = StepDefinition & Processor;
