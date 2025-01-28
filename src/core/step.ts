import { OperationType } from "./exchange.ts";
import { type Destination, type Processor, type Source } from "./adapter.ts";

export type StepDefinition = {
  operation: OperationType;
};

export type FromStepDefinition<T = unknown> = StepDefinition<T> & Source<T>;
export type ToStepDefinition<T = unknown> = StepDefinition<T> & Destination<T>;
export type ProcessStepDefinition<T = unknown> = StepDefinition<T> & Processor<T>;
