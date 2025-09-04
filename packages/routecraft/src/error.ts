export enum ErrorCode {
  // Definitions
  INVALID_ROUTE_DEFINITION = "INVALID_ROUTE_DEFINITION",
  DUPLICATE_ROUTE_DEFINITION = "DUPLICATE_ROUTE_DEFINITION",
  INVALID_OPERATION = "INVALID_OPERATION_TYPE",
  MISSING_FROM_DEFINITION = "MISSING_FROM_DEFINITION",

  // Lifecycle Errors
  ROUTE_COULD_NOT_START = "ROUTE_COULD_NOT_START",
  CONTEXT_COULD_NOT_START = "CONTEXT_COULD_NOT_START",

  // Generic Adapter Runtime Errors
  FROM_ERROR = "SOURCE_ERROR",
  PROCESS_ERROR = "PROCESSING_ERROR",
  TO_ERROR = "DESTINATION_ERROR",
  SPLIT_ERROR = "SPLITTING_ERROR",
  AGGREGATE_ERROR = "AGGREGATION_ERROR",
  TRANSFORM_ERROR = "TRANSFORMING_ERROR",
  TAP_ERROR = "TAPPING_ERROR",
  FILTER_ERROR = "FILTER_ERROR",
  VALIDATE_ERROR = "VALIDATE_ERROR",
  // Generic Runtime Error
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export class RouteCraftError extends Error {
  constructor(
    private details: {
      code: ErrorCode;
      message: string;
      suggestion?: string | undefined;
      docs?: string | undefined;
      cause?: unknown | undefined;
    },
  ) {
    super(details.message, { cause: details.cause });
    this.name = "RouteCraftError";
    this.details.docs =
      details.docs || "https://routecraft.dev/docs/reference/errors";
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

  static parse(cause: unknown): { message: string; error: Error } {
    return cause instanceof Error
      ? { message: cause.message, error: cause }
      : { message: String(cause), error: new Error(String(cause)) };
  }

  static create: (
    cause: unknown,
    options?: Partial<RouteCraftError>,
  ) => RouteCraftError = (cause, options?) => {
    const parsedError = RouteCraftError.parse(cause);
    if (parsedError.error instanceof RouteCraftError) {
      return parsedError.error;
    }
    return new RouteCraftError({
      code: ErrorCode.UNKNOWN_ERROR,
      message: String(cause),
      cause,
      ...options,
    });
  };
}
