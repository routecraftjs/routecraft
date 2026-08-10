import { BRAND, setBrand } from "./brand.ts";

/**
 * Well-known error categories used by core codes. Ecosystem packages may
 * use their own category strings; the `(string & {})` arm keeps
 * autocomplete on the known set while accepting any value.
 */
export type KnownErrorCategory =
  "Definition" | "DSL" | "Lifecycle" | "Adapter" | "Runtime";

export type RCMeta = {
  category: KnownErrorCategory | (string & {});
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
  RC5025: RCMeta;
  RC5026: RCMeta;
  RC5028: RCMeta;
  RC5029: RCMeta;
  RC5030: RCMeta;
  RC5031: RCMeta;
  RC5032: RCMeta;
  RC5033: RCMeta;
  RC5034: RCMeta;
  RC5035: RCMeta;
  RC5036: RCMeta;
  RC5037: RCMeta;
  RC5038: RCMeta;
  RC5039: RCMeta;
  RC5040: RCMeta;
  RC5041: RCMeta;
  RC5042: RCMeta;
  RC5043: RCMeta;
  RC5044: RCMeta;
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
    message: "authenticate() called with invalid claims",
    suggestion:
      "authenticate() (and the .authenticate() operation) require a non-empty `subject` naming the verified identity, and reject delegation state (`actor`, `grantId`): minting establishes identity, delegate() establishes who is acting for it. This is a programming error at the mint call, distinct from RC5023 (a principal that reached authorize() without being established by a trusted origin).",
    docs: `${DOCS_BASE}#rc-5024`,
    retryable: false,
  },
  RC5025: {
    category: "Runtime",
    message: "Circuit breaker is open",
    suggestion:
      "The route or step exceeded its failure threshold and is failing fast to prevent cascading failures against a downstream that is known to be unhealthy. Wait for the cooldown to elapse (the breaker then probes with a half-open call), configure a `fallback` to return a degraded result instead of throwing, or raise `failureThreshold` / `cooldownMs` if the breaker is too sensitive. Not retryable: an immediate retry would hit the same open breaker.",
    docs: `${DOCS_BASE}#rc-5025`,
    retryable: false,
  },
  RC5026: {
    category: "Runtime",
    message: "Concurrency limit exceeded",
    suggestion:
      "The route or step is at its `.concurrency({ max })` bulkhead limit and is failing fast (reject mode, or a full `maxQueue`) instead of admitting more simultaneous work. Retryable: a slot frees as soon as in-flight work completes, so an outer `.retry()` (which sits outside the bulkhead) can back off and re-acquire one. Raise `max`, switch to the default queue mode to apply backpressure instead, or shed load (e.g. return 503) in `.error()`.",
    docs: `${DOCS_BASE}#rc-5026`,
    retryable: true,
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
  RC5031: {
    category: "Runtime",
    message: "Exchange dropped before completion",
    suggestion:
      "The target route discarded the exchange instead of completing it (a filter rejected it, the source's onParseError was 'drop', or an error handler returned recovery.drop()), so there is no response body for a request/reply caller. If the caller should receive a value, recover with a body in .error() or let the exchange pass the filter.",
    docs: `${DOCS_BASE}#rc-5031`,
    retryable: false,
  },
  RC5032: {
    category: "Runtime",
    message: "Unsupported step outcome",
    suggestion:
      "A step returned a StepOutcome kind the engine cannot schedule yet. The 'suspend' kind is reserved for the route-level suspend/resume feature and is not implemented; no built-in step produces it. If you wrote a custom step, return a supported outcome (continue, complete, drop, branch, fanOut). Retrying will not help.",
    docs: `${DOCS_BASE}#rc-5032`,
    retryable: false,
  },
  RC5033: {
    category: "Adapter",
    message: "Dedupe key derivation failed",
    suggestion:
      "The default `.dedupe()` key hashes JSON.stringify(body); it fails on non-serialisable bodies (functions, symbols, circular refs, BigInt). Supply an explicit `key` function in dedupe({ key: ... }). Retrying will not help: the same body fails the same way.",
    docs: `${DOCS_BASE}#rc-5033`,
    retryable: false,
  },
  RC5034: {
    category: "Adapter",
    message: "Actor not permitted",
    suggestion:
      "The principal carries an actor (a delegate acting on the subject's behalf) that this route's authorize({ actor }) does not accept. The default is actor: 'none' (not agent-reachable). Declare the permitted actor(s) on the route, or have the caller act directly. Permanent under the current declaration.",
    docs: `${DOCS_BASE}#rc-5034`,
    retryable: false,
  },
  RC5035: {
    category: "Adapter",
    message: "Subject not permitted",
    suggestion:
      "The principal's subject does not match this route's authorize({ subject }) constraint (subject id, issuer, or profile). Permanent under current credentials.",
    docs: `${DOCS_BASE}#rc-5035`,
    retryable: false,
  },
  RC5036: {
    category: "Adapter",
    message: "Delegation chain too deep",
    suggestion:
      "The principal's actor chain is longer than the route's maxDelegationDepth (default 1). Re-delegation through further agents is not accepted here; have an agent closer to the subject perform the call, or raise maxDelegationDepth deliberately.",
    docs: `${DOCS_BASE}#rc-5036`,
    retryable: false,
  },
  RC5037: {
    category: "Adapter",
    message: "Delegation refused by mayAct",
    suggestion:
      "delegate() was asked to mint an actor the subject has not permitted (no matching mayAct entry). Obtain the subject's consent (record a grant, which populates mayAct) and retry. Never widen mayAct without an explicit consent event.",
    docs: `${DOCS_BASE}#rc-5037`,
    retryable: false,
  },
  RC5038: {
    category: "Adapter",
    message: "Insufficient authority (recoverable)",
    suggestion:
      "The identity is valid but lacks scope for this capability. The error's `missing` detail lists what is absent (RFC 9470 / RFC 6750 insufficient_scope shape). Obtain the missing grant via your consent flow, then retry.",
    docs: `${DOCS_BASE}#rc-5038`,
    // "Recoverable" describes the AUTHORIZATION outcome (a consent flow can
    // add the scope), not the request. Retrying the same call with the same
    // credential fails identically, so the retry wrapper must not treat this
    // as transient.
    retryable: false,
  },
  RC5039: {
    category: "Adapter",
    message: "HTTP webhook signature verification failed",
    suggestion:
      "A route with http({ signature: {...} }) rejected a request whose signature header was missing, invalid, or expired. Check that the secret matches the provider's signing secret, the header name matches what the provider sends (e.g. x-hub-signature-256), and the prefix matches the provider's format (e.g. \"sha256=\" for GitHub). If the provider's deliveries pass through a proxy that re-encodes the body, the signed bytes no longer match; verification must see the exact wire bytes.",
    docs: `${DOCS_BASE}#rc-5039`,
    retryable: false,
  },
  RC5040: {
    category: "Definition",
    message: "Resume-token signing secret not configured",
    suggestion:
      "A route in this context can reach a durable .suspend(), so resume tokens must be signable. Set the ROUTECRAFT_SUSPENSION_SECRET environment variable, or pass suspension: { secret } to defineConfig; generate one with `openssl rand -base64 32`. At least 32 bytes are required, because a resume token is a bearer capability and its holder can guess the secret offline without limit. The secret is never generated into the store: a store compromise must not yield forgeable resume tokens. testContext() and NODE_ENV=development or test mint an ephemeral in-memory key, so tests and local iteration need no setup.",
    docs: `${DOCS_BASE}#rc-5040`,
    retryable: false,
  },
  RC5041: {
    category: "Runtime",
    message: "Resume token rejected",
    suggestion:
      "The token presented to .resume() was malformed, carried a bad signature, or named a suspension this context cannot verify. Resume with the exact token minted at suspend time. If the token is genuine, check that every node shares one signing secret: a token signed with a different secret is indistinguishable from a forged one.",
    docs: `${DOCS_BASE}#rc-5041`,
    retryable: false,
  },
  RC5042: {
    category: "Runtime",
    message: "Exchange cannot be persisted for suspension",
    suggestion:
      "Suspension serializes the exchange to durable storage, so its body and headers must be plain JSON data. A function, symbol, bigint, class instance, circular reference, or secret-bearing value cannot be written. Move the offending value out of the exchange before the suspend point: resolve it to a string, keep it in context.store (which outlives the exchange and is not persisted), or recompute it after resume.",
    docs: `${DOCS_BASE}#rc-5042`,
    retryable: false,
  },
  RC5043: {
    category: "Adapter",
    message: "Principal restored from a suspension",
    suggestion:
      "authorize() rejected a principal that came back from durable storage with a resumed exchange. It is a recorded shape with no live credential behind it: nothing re-checked the signature, the expiry, or revocation. Re-verify the identity after resume with .authenticate() from a checked credential, or put the authorization on the resume ingress route, where the answering principal is verified live. Distinct from RC5023 (self-asserted) because the fix differs: re-verify, do not mint.",
    docs: `${DOCS_BASE}#rc-5043`,
    retryable: false,
  },
  RC5044: {
    category: "Runtime",
    message: "Suspension store operation failed",
    suggestion:
      "The suspension store could not complete a read or write. Common causes: a duplicate suspension id (a bug in id derivation, since ids are minted per suspend), a store file that is unwritable or out of disk, and a store written by a newer Routecraft build than the one now running. Deliberately not retryable: none of these clear on a second attempt, so a .retry() wrapper must not burn its budget on them.",
    docs: `${DOCS_BASE}#rc-5044`,
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
 * @param overrides - Optional overrides for message, suggestion, docs, or
 *   retryable (e.g. an adapter that knows a specific occurrence of a
 *   normally-permanent code is transient, or vice versa)
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
  overrides?: Partial<
    Pick<RCMeta, "message" | "suggestion" | "docs" | "retryable">
  >,
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
  // Replace, not merge: drop codes from a previous registration so a
  // same-owner re-registration (test runners, HMR) cannot leave stale
  // codes behind.
  for (const code of state.codes.keys()) {
    if (codePattern.test(code)) {
      state.codes.delete(code);
    }
  }
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
  return new Map(getErrorRegistry().codes);
}
