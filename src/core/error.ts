import { OperationType } from "./exchange.ts";

export enum ErrorCode {
  INVALID_ROUTE = "INVALID_ROUTE",
  MISSING_SOURCE = "MISSING_SOURCE",
  INVALID_OPERATION_TYPE = "INVALID_OPERATION_TYPE",
  SUBSCRIPTION_ERROR = "SUBSCRIPTION_ERROR",
  PROCESSING_ERROR = "PROCESSING_ERROR",
  DESTINATION_ERROR = "DESTINATION_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export class RouteCraftError extends Error {
  constructor(
    private details: {
      code: ErrorCode;
      message: string;
      suggestion?: string;
      docs?: string;
      cause?: unknown;
    },
  ) {
    super(details.message, { cause: details.cause });
    this.name = "RouteCraftError";
  }

  get code(): ErrorCode {
    return this.details.code;
  }

  get suggestion(): string | undefined {
    return this.details.suggestion;
  }

  get docs(): string | undefined {
    return this.details.docs;
  }

  override get cause(): unknown {
    return this.details.cause;
  }

  override toString(): string {
    let result = `[${this.details.code}] ${this.message}`;
    if (this.details.suggestion) {
      result += `\nSuggestion: ${this.details.suggestion}`;
    }
    if (this.details.docs) {
      result += `\nDocs: ${this.details.docs}`;
    }
    if (this.cause instanceof Error) {
      result += `\nCaused by: ${this.cause.message}`;
      if (this.cause.stack) {
        result += `\nStack trace:\n${this.cause.stack}`;
      }
    }
    return result;
  }
}

export interface CraftErrors {
  safeError(cause: unknown): { message: string; error?: Error };
  missingFromDefinition(routeId: string): RouteCraftError;
  subscriptionFailed(routeId: string, cause?: unknown): RouteCraftError;
  invalidOperation(routeId: string, operation: OperationType): RouteCraftError;
  processingError(routeId: string, cause?: unknown): RouteCraftError;
  destinationError(routeId: string, cause?: unknown): RouteCraftError;
}

export const CraftErrors: CraftErrors = {
  safeError: (cause: unknown) => {
    return cause instanceof Error
      ? { message: cause.message, error: cause }
      : { message: String(cause) };
  },
  missingFromDefinition: (routeId: string) =>
    new RouteCraftError({
      code: ErrorCode.MISSING_SOURCE,
      message: `Route "${routeId}" is missing a source`,
      suggestion:
        "Add a source using .from() to specify where the route should start processing. " +
        "For example: route.from(simple(() => 'Hello, World!'))",
      docs: "https://routecraft.dev/docs/core/route#from",
    }),
  subscriptionFailed: (routeId: string, cause?: unknown) => {
    const { error } = CraftErrors.safeError(cause);
    return new RouteCraftError({
      code: ErrorCode.SUBSCRIPTION_ERROR,
      message: `Failed to subscribe to source in route "${routeId}"`,
      cause: error,
    });
  },
  invalidOperation: (routeId: string, operation: OperationType) =>
    new RouteCraftError({
      code: ErrorCode.INVALID_OPERATION_TYPE,
      message:
        `Operation "${operation}" is not supported in route "${routeId}"`,
    }),
  processingError: (routeId: string, cause?: unknown) => {
    const { error } = CraftErrors.safeError(cause);
    return new RouteCraftError({
      code: ErrorCode.PROCESSING_ERROR,
      message: `Error processing in route "${routeId}"`,
      cause: error,
    });
  },
  destinationError: (routeId: string, cause?: unknown) => {
    const { error } = CraftErrors.safeError(cause);
    return new RouteCraftError({
      code: ErrorCode.DESTINATION_ERROR,
      message: `Error sending to destination in route "${routeId}"`,
      cause: error,
    });
  },
};
