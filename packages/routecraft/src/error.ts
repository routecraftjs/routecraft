import { BRAND, setBrand } from "./brand.ts";

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
  | "RC5010"
  | "RC5011"
  | "RC5012"
  | "RC5013"
  | "RC5014"
  | "RC5015"
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
    message: "Step execution failed",
    suggestion:
      "Read the error message and suggestion; check adapter documentation",
    docs: `${DOCS_BASE}#rc-5001`,
    retryable: true, // Per instance; adapter may override
  },
  RC5002: {
    category: "Adapter",
    message: "Validation failed",
    suggestion: "Adjust the schema or coerce input; check data shapes",
    docs: `${DOCS_BASE}#rc-5002`,
    retryable: false,
  },
  RC5003: {
    category: "Adapter",
    message: "Adapter misconfigured",
    suggestion:
      "Check required options and correct role usage (.from() vs .to())",
    docs: `${DOCS_BASE}#rc-5003`,
    retryable: false,
  },
  RC5004: {
    category: "Adapter",
    message: "No handler available",
    suggestion:
      "Ensure the consumer route is running before sending. Check route startup order.",
    docs: `${DOCS_BASE}#rc-5004`,
    retryable: false,
  },
  RC5010: {
    category: "Adapter",
    message: "Connection failed",
    suggestion:
      "Check network, DNS, ports, and firewall; verify service is running",
    docs: `${DOCS_BASE}#rc-5010`,
    retryable: true,
  },
  RC5011: {
    category: "Adapter",
    message: "Request timeout",
    suggestion: "Increase timeout or configure retry with backoff",
    docs: `${DOCS_BASE}#rc-5011`,
    retryable: true,
  },
  RC5012: {
    category: "Adapter",
    message: "Authentication failed",
    suggestion: "Verify API keys, tokens, and credential configuration",
    docs: `${DOCS_BASE}#rc-5012`,
    retryable: false,
  },
  RC5013: {
    category: "Adapter",
    message: "Rate limited",
    suggestion: "Reduce request frequency or configure retry with backoff",
    docs: `${DOCS_BASE}#rc-5013`,
    retryable: true,
  },
  RC5014: {
    category: "Adapter",
    message: "Resource not found",
    suggestion:
      "Check that the resource exists (model ID, endpoint, queue name)",
    docs: `${DOCS_BASE}#rc-5014`,
    retryable: false,
  },
  RC5015: {
    category: "Adapter",
    message: "Permission denied",
    suggestion: "Check access control, IAM, and scopes",
    docs: `${DOCS_BASE}#rc-5015`,
    retryable: false,
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
    setBrand(this, BRAND.RouteCraftError);
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

  /**
   * Used by pino and other serializers so log output includes rc, message, suggestion, docs, causeMessage, causeStack as searchable fields.
   */
  toJSON(): Record<string, unknown> {
    const causeMessage =
      this.cause instanceof Error
        ? this.cause.message
        : this.cause !== undefined
          ? String(this.cause)
          : undefined;
    const causeStack =
      this.cause instanceof Error ? this.cause.stack : undefined;
    return {
      type: "RouteCraftError",
      name: this.name,
      rc: this.rc,
      message: this.meta.message,
      suggestion: this.meta.suggestion,
      docs: this.meta.docs,
      causeMessage,
      causeStack,
      retryable: this.retryable,
      stack: this.stack,
    };
  }

  static parse(cause: unknown): { message: string; error: Error } {
    return cause instanceof Error
      ? { message: cause.message, error: cause }
      : { message: String(cause), error: new Error(String(cause)) };
  }
}

/**
 * Creates a RouteCraftError with the given code and optional cause/overrides.
 *
 * @param rc - Error code from the RC registry (e.g. "RC5001", "RC1002")
 * @param cause - Optional underlying error (stored as cause, message can be overridden)
 * @param overrides - Optional overrides for message, suggestion, or docs
 * @returns A RouteCraftError instance (branded, with retryable from RC meta)
 *
 * @example
 * ```typescript
 * throw rcError("RC5002", new Error("Invalid payload"), { message: "Validation failed" });
 * ```
 */
export function rcError(
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

/** @deprecated Use rcError. Kept for API compatibility. */
export const error = rcError;
