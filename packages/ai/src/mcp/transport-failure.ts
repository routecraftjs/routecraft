import {
  isRoutecraftError,
  rcError,
  type RoutecraftError,
} from "@routecraft/routecraft";

/**
 * Name a failed MCP call by what went wrong on the wire, so `.retry()` and
 * `.circuitBreaker()` treat a dropped connection as transient and a refused
 * credential as final.
 *
 * | Failure | Code | Retried |
 * | --- | --- | --- |
 * | The remote answered with a JSON-RPC error, or the URL does not parse | `RC5003` | no |
 * | HTTP 401, or the SDK's unauthorized error | `RC5012` | no |
 * | HTTP 403 | `RC5015` | no |
 * | HTTP 404 | `RC5014` | no |
 * | HTTP 429 | `RC5013` | yes |
 * | HTTP 408 or 504, or a timeout at any depth of the cause chain | `RC5011` | yes |
 * | Any other HTTP 4xx | `RC5003` | no |
 * | A fault the SDK found on its own side: an invalid or unsupported result, a missing capability, a failed version negotiation | `RC5003` | no |
 * | Anything else: refused, reset, DNS, HTTP 5xx, a closed stdio pipe | `RC5010` | yes |
 *
 * The classification is structural on purpose. The SDK is an optional peer,
 * and its error classes are matched by brand rather than by prototype, so a
 * check on shape holds across duplicate installs where `instanceof` does not.
 *
 * A failure the framework already named passes through unchanged.
 *
 * @param cause - What the SDK, the transport or `fetch` threw.
 * @param message - The dispatch site's own account of the call.
 */
export function transportFailure(
  cause: unknown,
  message: string,
): RoutecraftError {
  if (isRoutecraftError(cause)) return cause;
  return rcError(codeOf(cause), cause, { message });
}

type TransportCode =
  "RC5003" | "RC5010" | "RC5011" | "RC5012" | "RC5013" | "RC5014" | "RC5015";

function codeOf(cause: unknown): TransportCode {
  if (isJsonRpcError(cause) || isInvalidUrl(cause)) return "RC5003";
  const status = httpStatusOf(cause);
  if (status === 401 || nameOf(cause) === "UnauthorizedError") return "RC5012";
  if (status === 403) return "RC5015";
  if (status === 404) return "RC5014";
  if (status === 429) return "RC5013";
  if (status === 408 || status === 504) return "RC5011";
  if (status !== undefined && status >= 400 && status < 500) return "RC5003";
  if (status === undefined && isTimeout(cause)) return "RC5011";
  if (status === undefined && isLocalFault(cause)) return "RC5003";
  return "RC5010";
}

/**
 * Whether the remote answered the request with a JSON-RPC error. The SDK
 * marks one with a numeric code; its own faults carry a string. A
 * `DOMException` also has a numeric code and is an abort or a timeout, never
 * an answer.
 *
 * @internal
 */
export function isJsonRpcError(cause: unknown): boolean {
  return (
    nameOf(cause) === "ProtocolError" ||
    (cause instanceof Error &&
      !(cause instanceof DOMException) &&
      typeof (cause as { code?: unknown }).code === "number" &&
      httpStatusOf(cause) === undefined)
  );
}

/**
 * The SDK's string codes for a fault retrying cannot change. A result that
 * fails validation arrives after the remote ran the tool, so calling it
 * retryable would run the tool again.
 */
const LOCAL_FAULT_CODES = new Set([
  "ALREADY_CONNECTED",
  "NOT_INITIALIZED",
  "CAPABILITY_NOT_SUPPORTED",
  "INVALID_RESULT",
  "UNSUPPORTED_RESULT_TYPE",
  "INPUT_REQUIRED_ROUNDS_EXCEEDED",
  "LIST_PAGINATION_EXCEEDED",
  "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION",
  "ERA_NEGOTIATION_FAILED",
  "CLIENT_HTTP_NOT_IMPLEMENTED",
]);

function isLocalFault(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && LOCAL_FAULT_CODES.has(code);
}

function isInvalidUrl(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "ERR_INVALID_URL";
}

/**
 * The HTTP status the remote answered with, when the failure is one.
 *
 * @internal
 */
export function httpStatusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function nameOf(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.name : undefined;
}

const TIMEOUT_CODES = new Set([
  "REQUEST_TIMEOUT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** A `fetch` failure hides its reason in `cause`, so the chain is walked. */
function isTimeout(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TIMEOUT_CODES.has(code)) return true;
    if (current.name === "TimeoutError") return true;
    if (/\btimed out\b/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
