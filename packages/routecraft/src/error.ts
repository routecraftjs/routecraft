export type RCCode =
  | "RC1001"
  | "RC1002"
  | "RC2001"
  | "RC2002"
  | "RC3001"
  | "RC3002"
  | "RC5001"
  | "RC5002"
  | "RC5003"
  | "RC5004"
  | "RC5005"
  | "RC5006"
  | "RC5007"
  | "RC5008"
  | "RC5009"
  | "RC5010"
  | "RC5011"
  | "RC9901";

export type RCMeta = {
  category: "Definition" | "DSL" | "Lifecycle" | "Adapter" | "Runtime";
  message: string;
  suggestion?: string;
  docs: string;
  /**
   * Whether this error should be retried by the retry wrapper.
   * - `true`: Transient error, retry may succeed (e.g., network issues)
   * - `false`: Permanent error, retry will not help (e.g., validation, config)
   */
  retryable: boolean;
};

export const DOCS_BASE = "https://routecraft.dev/docs/reference/errors";

export const RC: Record<RCCode, RCMeta> = {
  RC1001: {
    category: "Definition",
    message: "Route definition failed validation",
    suggestion: "Ensure a source is defined: start with from(adapter)",
    docs: `${DOCS_BASE}#rc-1001`,
    retryable: false, // Config error - won't change on retry
  },
  RC1002: {
    category: "Definition",
    message: "Duplicate route id",
    suggestion: "Ensure each route id is unique or set routeOptions.id",
    docs: `${DOCS_BASE}#rc-1002`,
    retryable: false, // Config error - won't change on retry
  },
  RC2001: {
    category: "DSL",
    message: "Invalid operation type",
    suggestion: "Use a supported operator and verify the step name",
    docs: `${DOCS_BASE}#rc-2001`,
    retryable: false, // DSL error - won't change on retry
  },
  RC2002: {
    category: "DSL",
    message: "Missing from step",
    suggestion: "Start the route with from and a valid source adapter",
    docs: `${DOCS_BASE}#rc-2002`,
    retryable: false, // DSL error - won't change on retry
  },
  RC3001: {
    category: "Lifecycle",
    message: "Route failed to start",
    suggestion: "Ensure the route is not aborted and adapters are configured",
    docs: `${DOCS_BASE}#rc-3001`,
    retryable: false, // Lifecycle error - requires intervention
  },
  RC3002: {
    category: "Lifecycle",
    message: "Context failed to start",
    suggestion: "Validate plugin exports and global configuration",
    docs: `${DOCS_BASE}#rc-3002`,
    retryable: false, // Lifecycle error - requires intervention
  },
  RC5001: {
    category: "Adapter",
    message: "Source adapter threw",
    suggestion: "Verify connectivity and adapter options",
    docs: `${DOCS_BASE}#rc-5001`,
    retryable: true, // Often transient (network, service unavailable)
  },
  RC5002: {
    category: "Adapter",
    message: "Processing step threw",
    suggestion: "Add guards to transforms and processors",
    docs: `${DOCS_BASE}#rc-5002`,
    retryable: true, // Could be transient depending on processor
  },
  RC5003: {
    category: "Adapter",
    message: "Destination adapter threw",
    suggestion: "Verify destination connectivity and options",
    docs: `${DOCS_BASE}#rc-5003`,
    retryable: true, // Often transient (network, service unavailable)
  },
  RC5004: {
    category: "Adapter",
    message: "Split operation failed",
    suggestion: "Ensure the input is iterable and guarded",
    docs: `${DOCS_BASE}#rc-5004`,
    retryable: false, // Logic error - same input will fail again
  },
  RC5005: {
    category: "Adapter",
    message: "Aggregation operation failed",
    suggestion: "Validate partial shapes and defaults",
    docs: `${DOCS_BASE}#rc-5005`,
    retryable: false, // Logic error - same input will fail again
  },
  RC5006: {
    category: "Adapter",
    message: "Transform function threw",
    suggestion: "Narrow input types and add guards",
    docs: `${DOCS_BASE}#rc-5006`,
    retryable: false, // Logic error - same input will fail again
  },
  RC5007: {
    category: "Adapter",
    message: "Tap step threw",
    suggestion: "Keep tap side effects resilient",
    docs: `${DOCS_BASE}#rc-5007`,
    retryable: true, // Taps often call external services
  },
  RC5008: {
    category: "Adapter",
    message: "Filter predicate threw",
    suggestion: "Guard against missing properties and unexpected shapes",
    docs: `${DOCS_BASE}#rc-5008`,
    retryable: false, // Logic error - same input will fail again
  },
  RC5009: {
    category: "Adapter",
    message: "Validation failed",
    suggestion: "Adjust the schema or coerce input",
    docs: `${DOCS_BASE}#rc-5009`,
    retryable: false, // Bad input - won't change on retry
  },
  RC5010: {
    category: "Adapter",
    message: "Dynamic endpoints cannot be used as source",
    suggestion:
      'Direct adapter with function endpoint can only be used with .to() or .tap(), not .from(). Use .from(direct("endpoint", {})) for source.',
    docs: `${DOCS_BASE}#rc-5010`,
    retryable: false, // Config error - won't change on retry
  },
  RC5011: {
    category: "Adapter",
    message: "Direct route schema validation failed",
    suggestion:
      "Check that message body and headers match the schema. For Zod 4: z.object() strips extras, z.looseObject() keeps them, z.strictObject() rejects them.",
    docs: `${DOCS_BASE}#rc-5011`,
    retryable: false, // Bad input - same data will fail again
  },
  RC9901: {
    category: "Runtime",
    message: "Unknown error",
    suggestion: "Check logs and enable debug level",
    docs: `${DOCS_BASE}#rc-9901`,
    retryable: true, // Unknown - optimistic default
  },
};

export class RouteCraftError extends Error {
  /**
   * Whether this error should be retried by the retry wrapper.
   */
  public readonly retryable: boolean;

  constructor(
    public readonly rc: RCCode,
    public readonly meta: RCMeta,
    cause?: unknown,
  ) {
    super(meta.message, { cause });
    this.name = "RouteCraftError";
    this.retryable = meta.retryable;
  }

  override toString(): string {
    let result = `[${this.rc}] ${this.meta.message}`;
    if (this.meta.suggestion) {
      result += `\nSuggestion, ${this.meta.suggestion}`;
    }
    result += `\nDocs, ${this.meta.docs}`;
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
}

export function error(
  rc: RCCode,
  cause?: unknown,
  overrides?: Partial<Pick<RCMeta, "message" | "suggestion" | "docs">>,
): RouteCraftError {
  const base = RC[rc];
  const meta: RCMeta = {
    ...base,
    ...(overrides || {}),
    docs: overrides?.docs ?? base.docs,
  };
  const parsed = cause ? RouteCraftError.parse(cause).error : undefined;
  return new RouteCraftError(rc, meta, parsed);
}
