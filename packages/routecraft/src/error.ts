import { BRAND, setBrand } from "./brand.ts";

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

/**
 * Open error-code registry. Core declares its own `RC####` codes here;
 * ecosystem packages add namespaced codes via declaration merging plus a
 * runtime {@link registerErrorCodes} call:
 *
 * ```typescript
 * declare module "@routecraft/routecraft" {
 *   interface ErrorCodeRegistry {
 *     AI1001: RCMeta;
 *   }
 * }
 * registerErrorCodes("AI", { AI1001: { ... } }, "@routecraft/ai");
 * ```
 *
 * The `RC` namespace is reserved for core. Each namespace is claimable by
 * exactly one owner package, which makes cross-package code collisions a
 * detectable package-identity conflict instead of a silent numbering
 * accident (TypeScript merges identical `X: RCMeta` declarations without
 * complaint, so the compiler alone cannot catch them).
 */
export interface ErrorCodeRegistry {
  RC1001: RCMeta;
  RC1002: RCMeta;
  RC1003: RCMeta;
  RC2001: RCMeta;
  RC2002: RCMeta;
  RC3001: RCMeta;
  RC3002: RCMeta;
  RC5001: RCMeta;
  RC5002: RCMeta;
  RC5003: RCMeta;
  RC5004: RCMeta;
  RC5010: RCMeta;
  RC5011: RCMeta;
  RC5012: RCMeta;
  RC5013: RCMeta;
  RC5014: RCMeta;
  RC5015: RCMeta;
  RC5016: RCMeta;
  RC5017: RCMeta;
  RC5018: RCMeta;
  RC5019: RCMeta;
  RC5020: RCMeta;
  RC5021: RCMeta;
  RC5022: RCMeta;
  RC5023: RCMeta;
  RC5024: RCMeta;
  RC5028: RCMeta;
  RC5029: RCMeta;
  RC5030: RCMeta;
  RC9901: RCMeta;
}

/** All known error codes: core `RC####` plus registered ecosystem namespaces. */
export type RCCode = keyof ErrorCodeRegistry;

export const DOCS_BASE = "https://routecraft.dev/docs/reference/errors";

/**
 * Core codes only: the `RC####` keys declared in this file. Ecosystem keys
 * merged into {@link ErrorCodeRegistry} are excluded so the `RC` const
 * below stays exhaustively checked against what core actually defines.
 */
type CoreErrorCode = keyof ErrorCodeRegistry & `RC${number}`;

export const RC: { [K in CoreErrorCode]: RCMeta } = {
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
  RC1003: {
    category: "Definition",
    message: "Error code registration failed",
    suggestion:
      "Namespaces must match /^[A-Z][A-Z0-9]{1,7}$/, 'RC' is reserved for core, each namespace is claimable by exactly one package, and every code must be the namespace followed by exactly four digits. If two packages claim the same namespace, report the collision to both package owners.",
    docs: `${DOCS_BASE}#rc-1003`,
    retryable: false,
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
  RC5016: {
    category: "Adapter",
    message: "Source payload parse failed",
    suggestion:
      "Check the input data matches the adapter's expected format (JSON, CSV, JSONL, HTML, MIME). Wire .error() on the route to recover, or set onParseError to 'abort' (stop the source) or 'drop' (emit exchange:dropped) on the adapter.",
    docs: `${DOCS_BASE}#rc-5016`,
    retryable: false,
  },
  RC5017: {
    category: "Adapter",
    message: "Optional peer dependency missing",
    suggestion:
      "Install the optional peer the adapter requires (the error message names the package).",
    docs: `${DOCS_BASE}#rc-5017`,
    retryable: false,
  },
  RC5018: {
    category: "Adapter",
    message: "HTTP source request rejected",
    suggestion:
      "Check that the request method and path match a registered http() source. 404 means no route is bound to that path; 405 means the path exists but the method differs; unsupported response body shapes (ReadableStream, AsyncIterable) fall under this code until SSE lands in a follow-up.",
    docs: `${DOCS_BASE}#rc-5018`,
    retryable: false,
  },
  RC5019: {
    category: "Adapter",
    message: "HTTP server bind failed",
    suggestion:
      "Check that the configured port is free and the host is reachable. EADDRINUSE means another process owns the port; EADDRNOTAVAIL means the host is not one this machine can bind to.",
    docs: `${DOCS_BASE}#rc-5019`,
    retryable: false,
  },
  RC5020: {
    category: "Adapter",
    message: "Authorization failed: token expired during processing",
    suggestion:
      "The verified principal carried an `expiresAt` that is now in the past; a long-running step (LLM call, slow downstream) outlived the credential. The client should refresh and retry. Distinct from RC5012 (no principal) and RC5015 (wrong roles/scopes) so callers can react accordingly.",
    docs: `${DOCS_BASE}#rc-5020`,
    retryable: false,
  },
  RC5021: {
    category: "Adapter",
    message: "Principal enrichment failed",
    suggestion:
      "The `userinfo` option on `mcpPlugin({})` could not enrich the verified principal. The cause names the underlying problem (HTTP status, network error, malformed JSON, missing `userinfo_endpoint` in the OIDC Discovery document). Verify the userinfo endpoint URL, IdP availability, and the bearer token's scope grants. Fail-closed: the request is rejected to prevent silent identity gaps.",
    docs: `${DOCS_BASE}#rc-5021`,
    retryable: false,
  },
  RC5022: {
    category: "Adapter",
    message: "Userinfo sub invariant violated",
    suggestion:
      "Per OIDC Core §5.3.2, the userinfo response MUST carry a `sub` matching the verified token's `sub`. A mismatch (or missing `sub`) indicates a compromised userinfo endpoint or a configuration error mapping the wrong userinfo URL to the bearer's issuer. The request is rejected to prevent identity confusion.",
    docs: `${DOCS_BASE}#rc-5022`,
    retryable: false,
  },
  RC5023: {
    category: "Adapter",
    message: "Authorization failed: principal is not authentic",
    suggestion:
      'A principal was present but was not established by a trusted origin (a plain object written onto headers["routecraft.auth.principal"] is self-asserted). Mint identity with the .authenticate() operation or the authenticate() helper, or let a source verifier (jwt/jwks/oauth) attach it. Distinct from RC5012 (no principal) and RC5015 (wrong roles/scopes).',
    docs: `${DOCS_BASE}#rc-5023`,
    retryable: false,
  },
  RC5024: {
    category: "Adapter",
    message: "authenticate() called without a subject",
    suggestion:
      "authenticate() (and the .authenticate() operation) require a non-empty `subject` naming the verified identity, e.g. authenticate({ subject: sender.address, roles: [...] }). This is a programming error at the mint call, distinct from RC5023 (a principal that reached authorize() without being established by a trusted origin).",
    docs: `${DOCS_BASE}#rc-5024`,
    retryable: false,
  },
  RC5028: {
    category: "Adapter",
    message: "Cache provider failed",
    suggestion:
      "Inspect the underlying cache backend (in-memory, Redis, etc.); transient backend errors may resolve on retry.",
    docs: `${DOCS_BASE}#rc-5028`,
    retryable: true,
  },
  RC5029: {
    category: "Adapter",
    message: "Cache key derivation failed",
    suggestion:
      "The default key hashes JSON.stringify(body); it fails on non-serialisable bodies (functions, symbols, circular refs, BigInt). Supply an explicit `key` function in cache({ key: ... }). Retrying will not help: the same body fails the same way.",
    docs: `${DOCS_BASE}#rc-5029`,
    retryable: false,
  },
  RC5030: {
    category: "Adapter",
    message: "Resource changed (precondition failed)",
    suggestion:
      "A conditional write failed because the resource changed on the server since it was read (HTTP 412 / ETag mismatch, a mid-air collision). Re-read the resource and re-apply the change; a blind retry with the same precondition will keep failing, so this is not retryable.",
    docs: `${DOCS_BASE}#rc-5030`,
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

export class RoutecraftError extends Error {
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
    this.name = "RoutecraftError";
    this.retryable = meta.retryable;
    setBrand(this, BRAND.RoutecraftError);
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
      type: "RoutecraftError",
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
 * Standard Schema issue shape (subset of StandardSchemaV1.Issue).
 * Used to format validation errors into human-readable messages.
 */
interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}

/**
 * Formats Standard Schema validation issues into a human-readable string.
 * Each issue becomes "path: message" (or just "message" when there is no path).
 *
 * @param issues - The raw issues value from a Standard Schema validation result
 * @returns A formatted string describing what failed
 *
 * @example
 * ```
 * formatSchemaIssues([{ message: "Required", path: ["name"] }])
 * // => '"name": Required'
 * ```
 */
export function formatSchemaIssues(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return typeof issues === "object" ? JSON.stringify(issues) : String(issues);
  }

  return (issues as SchemaIssue[])
    .map((issue) => {
      const path = formatIssuePath(issue.path);
      const msg = issue.message ?? "unknown error";
      return path ? `"${path}": ${msg}` : msg;
    })
    .join("; ");
}

/**
 * Converts a Standard Schema path array into a dot-separated string.
 */
function formatIssuePath(
  path: SchemaIssue["path"] | undefined,
): string | undefined {
  if (!path || path.length === 0) return undefined;
  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
}

/**
 * Creates a RoutecraftError with the given code and optional cause/overrides.
 *
 * @param rc - Error code from the RC registry (e.g. "RC5001", "RC1002")
 * @param cause - Optional underlying error (stored as cause, message can be overridden)
 * @param overrides - Optional overrides for message, suggestion, or docs
 * @returns A RoutecraftError instance (branded, with retryable from RC meta)
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
): RoutecraftError {
  const base = getErrorMeta(rc);
  const meta: RCMeta = {
    ...base,
    ...(overrides || {}),
    docs: overrides?.docs ?? base.docs,
  };
  const parsed =
    cause !== undefined ? RoutecraftError.parse(cause).error : undefined;
  return new RoutecraftError(rc, meta, parsed);
}

/**
 * Cross-instance runtime registry of error codes (core + ecosystem) and
 * claimed namespaces. `Symbol.for` so multiple copies of the package in a
 * workspace share one registry, mirroring the config-applier registry.
 */
const ERROR_REGISTRY_KEY: unique symbol = Symbol.for(
  "routecraft.error-code-registry",
);

type ErrorRegistryState = {
  codes: Map<string, RCMeta>;
  /** namespace -> owner package name */
  namespaces: Map<string, string>;
};

type GlobalWithErrorRegistry = typeof globalThis & {
  [ERROR_REGISTRY_KEY]?: ErrorRegistryState;
};

function getErrorRegistry(): ErrorRegistryState {
  const g = globalThis as GlobalWithErrorRegistry;
  let state = g[ERROR_REGISTRY_KEY];
  if (!state) {
    state = { codes: new Map(), namespaces: new Map() };
    state.namespaces.set("RC", "@routecraft/routecraft");
    for (const [code, meta] of Object.entries(RC)) {
      state.codes.set(code, meta);
    }
    g[ERROR_REGISTRY_KEY] = state;
  }
  return state;
}

/** Namespace shape: 2-8 chars, uppercase alphanumeric, starts with a letter. */
const NAMESPACE_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

/**
 * Register ecosystem error codes under a claimed namespace.
 *
 * Call once at module load time (typically from a side-effect import next
 * to the matching `declare module` augmentation of {@link ErrorCodeRegistry}).
 * Each namespace is claimable by exactly one owner package; a second claim
 * throws RC1003 naming both packages so consumers know which two packages
 * collide (they cannot fix the collision themselves). Re-registration by
 * the same owner is idempotent and replaces the previous codes, so module
 * re-evaluation (test runners, HMR) is safe.
 *
 * @param namespace - Unique uppercase prefix, e.g. "AI" (`RC` is reserved for core)
 * @param codes - Map of `${namespace}${4 digits}` codes to their metadata
 * @param owner - Owning package name, used in collision diagnostics
 *
 * @example
 * ```typescript
 * registerErrorCodes(
 *   "AI",
 *   { AI1001: { category: "Adapter", message: "...", docs: "...", retryable: false } },
 *   "@routecraft/ai",
 * );
 * ```
 */
export function registerErrorCodes(
  namespace: string,
  codes: Record<string, RCMeta>,
  owner: string,
): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw rcError("RC1003", undefined, {
      message: `Error namespace "${namespace}" is invalid: must match ${String(NAMESPACE_PATTERN)}.`,
    });
  }
  if (namespace === "RC") {
    throw rcError("RC1003", undefined, {
      message: `Error namespace "RC" is reserved for @routecraft/routecraft core codes.`,
    });
  }
  const state = getErrorRegistry();
  const existingOwner = state.namespaces.get(namespace);
  if (existingOwner !== undefined && existingOwner !== owner) {
    throw rcError("RC1003", undefined, {
      message:
        `Error namespace "${namespace}" is already claimed by "${existingOwner}" and cannot be claimed by "${owner}". ` +
        `Two installed packages picked the same namespace; report this collision to both package owners.`,
    });
  }
  const codePattern = new RegExp(`^${namespace}\\d{4}$`);
  for (const code of Object.keys(codes)) {
    if (!codePattern.test(code)) {
      throw rcError("RC1003", undefined, {
        message: `Error code "${code}" does not match its namespace: expected "${namespace}" followed by exactly four digits.`,
      });
    }
  }
  state.namespaces.set(namespace, owner);
  for (const [code, meta] of Object.entries(codes)) {
    state.codes.set(code, meta);
  }
}

/**
 * Look up the metadata for a code in the runtime registry (core +
 * registered ecosystem codes). Throws RC9901 for unknown codes, which in
 * practice means the package that registers the code was never imported.
 *
 * @internal Exposed for docs tooling and conformance tests.
 */
export function getErrorMeta(rc: string): RCMeta {
  const meta = getErrorRegistry().codes.get(rc);
  if (!meta) {
    throw new RoutecraftError(
      "RC9901" as RCCode,
      {
        ...RC.RC9901,
        message: `Unknown error code "${rc}". If this is an ecosystem code, import the package that registers it before use.`,
      },
      undefined,
    );
  }
  return meta;
}

/**
 * Snapshot of all registered codes (core + ecosystem), for docs tooling
 * and conformance tests.
 *
 * @internal
 */
export function getRegisteredErrorCodes(): ReadonlyMap<string, RCMeta> {
  return getErrorRegistry().codes;
}
