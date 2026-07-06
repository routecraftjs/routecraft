import { createHmac } from "node:crypto";
import { timingSafeStringEqual } from "../../auth/timing-safe";

const SCHEMES = [
  "hmac-sha256-hex",
  "hmac-sha1-hex",
  "stripe-timestamped",
] as const;

/**
 * Signature schemes supported by the built-in webhook verifier.
 *
 * - `"hmac-sha256-hex"`: hex-encoded HMAC-SHA256 of the raw body. GitHub's
 *   `X-Hub-Signature-256` uses this with `prefix: "sha256="`.
 * - `"hmac-sha1-hex"`: hex-encoded HMAC-SHA1 of the raw body. Legacy GitHub
 *   `X-Hub-Signature` uses this with `prefix: "sha1="`. Prefer sha256 when
 *   the provider offers both.
 * - `"stripe-timestamped"`: Stripe's `Stripe-Signature` format
 *   (`t=<unix>,v1=<hex>`). The signed payload is `<t>.<raw body>` and the
 *   timestamp must be within `toleranceSec` of the server clock, which
 *   bounds replay of captured deliveries.
 */
export type HttpWebhookSignatureScheme = (typeof SCHEMES)[number];

/**
 * Declarative webhook-signature verification for `http({...})` sources.
 * When configured, the plugin verifies the raw request bytes against the
 * signature header and rejects 401 before any route step runs, so HMAC
 * comparison never has to be hand-rolled in a `.filter()`.
 *
 * For providers whose scheme is not covered here, opt in to
 * `http({ rawBody: true })` instead and verify in a route step against
 * `routecraft.http.rawBody`.
 *
 * @experimental
 */
export interface HttpWebhookSignatureOptions {
  /** Request header carrying the signature (e.g. `"x-hub-signature-256"`). Case-insensitive. */
  header: string;
  /** Shared secret the provider signs with. */
  secret: string;
  /** Signature scheme. See {@link HttpWebhookSignatureScheme}. */
  scheme: HttpWebhookSignatureScheme;
  /**
   * Literal prefix stripped from the header value before comparison, e.g.
   * `"sha256="` for GitHub. A header value that does not start with the
   * prefix is an invalid signature. Ignored by `"stripe-timestamped"`,
   * which has its own field format.
   */
  prefix?: string;
  /**
   * Maximum allowed clock skew, in seconds, between the signature's
   * embedded timestamp and the server clock. Only used by
   * `"stripe-timestamped"`. Defaults to 300 (Stripe's recommended window).
   */
  toleranceSec?: number;
}

/**
 * Bounded rejection reasons, returned to clients in the 401 body and emitted
 * as the `reason` field on `auth:rejected`. Kept a closed vocabulary per the
 * security standard: never derived from `err.message` free text.
 */
export type HttpWebhookSignatureRejection =
  | "missing signature header"
  | "invalid signature"
  | "signature expired";

export type HttpWebhookSignatureResult =
  | { ok: true }
  | { ok: false; reason: HttpWebhookSignatureRejection };

const DEFAULT_TOLERANCE_SEC = 300;

/**
 * RFC 7230 header-name token. `Headers.get()` throws a TypeError on names
 * outside this set, so an invalid name must be rejected at construction
 * rather than exploding at the first delivery.
 */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Fixed hex-digest lengths per scheme, used to reject malformed candidates before hashing. */
const HEX_DIGEST_LENGTH = {
  "hmac-sha256-hex": 64,
  "hmac-sha1-hex": 40,
} as const;

/**
 * Validate a signature options object at construction time. Returns an
 * error message when the shape is invalid, `null` when it is usable.
 * The http source turns a non-null result into RC5003 so misconfiguration
 * fails at the `http({...})` call site, not at the first delivery.
 */
export function invalidSignatureOptionsReason(
  options: HttpWebhookSignatureOptions,
): string | null {
  if (typeof options !== "object" || options === null) {
    return `invalid signature options ${JSON.stringify(options)}. Pass { header, secret, scheme }.`;
  }
  if (
    typeof options.header !== "string" ||
    !HEADER_TOKEN.test(options.header)
  ) {
    return `invalid signature.header ${JSON.stringify(options.header)}. Pass a legal HTTP header name (RFC 7230 token, e.g. "x-hub-signature-256").`;
  }
  if (typeof options.secret !== "string" || options.secret === "") {
    return "invalid signature.secret. Pass the provider's non-empty signing secret.";
  }
  if (!SCHEMES.includes(options.scheme)) {
    return `invalid signature.scheme ${JSON.stringify(options.scheme)}. Allowed: ${SCHEMES.map((s) => `"${s}"`).join(", ")}.`;
  }
  if (options.prefix !== undefined && typeof options.prefix !== "string") {
    return `invalid signature.prefix ${JSON.stringify(options.prefix)}. Pass a string (e.g. "sha256=").`;
  }
  if (
    options.toleranceSec !== undefined &&
    (typeof options.toleranceSec !== "number" ||
      !Number.isFinite(options.toleranceSec) ||
      options.toleranceSec <= 0)
  ) {
    return `invalid signature.toleranceSec ${JSON.stringify(options.toleranceSec)}. Pass a positive number of seconds.`;
  }
  return null;
}

/**
 * Verify a webhook signature against the raw request bytes.
 *
 * All comparisons are timing-safe via the shared {@link timingSafeStringEqual}
 * (length-guarded `timingSafeEqual`, also used by the JWT HMAC validator).
 * Hex comparison is case-insensitive: providers disagree on digest casing
 * and hex case carries no information. Candidates whose length cannot match
 * the scheme's digest are rejected before any HMAC is computed, so floods of
 * malformed signatures do not pay a full-body hash. The verifier never
 * throws for untrusted input; every failure mode maps to a bounded
 * {@link HttpWebhookSignatureRejection}.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  headerValue: string | null,
  options: HttpWebhookSignatureOptions,
): HttpWebhookSignatureResult {
  if (headerValue === null || headerValue.trim() === "") {
    return { ok: false, reason: "missing signature header" };
  }

  if (options.scheme === "stripe-timestamped") {
    return verifyStripeTimestamped(rawBody, headerValue, options);
  }

  let candidate = headerValue.trim();
  if (options.prefix !== undefined) {
    if (!candidate.startsWith(options.prefix)) {
      return { ok: false, reason: "invalid signature" };
    }
    candidate = candidate.slice(options.prefix.length);
  }
  if (candidate.length !== HEX_DIGEST_LENGTH[options.scheme]) {
    return { ok: false, reason: "invalid signature" };
  }

  const digest = options.scheme === "hmac-sha256-hex" ? "sha256" : "sha1";
  const expected = createHmac(digest, options.secret)
    .update(rawBody)
    .digest("hex");
  return timingSafeStringEqual(expected, candidate.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/**
 * Verify Stripe's `t=<unix>,v1=<hex>` format. Multiple `v1` fields are
 * accepted (Stripe sends more than one during secret rotation); any match
 * admits. Unknown fields (`v0`, future versions) are ignored.
 *
 * The signed payload uses the raw `t` field text, not a re-serialised
 * parse of it: the provider signs the exact characters it sent, so
 * rebuilding from `parseInt` would reject non-canonical encodings. The
 * field must be digits-only; anything else is an invalid signature rather
 * than a silently truncated timestamp.
 */
function verifyStripeTimestamped(
  rawBody: Uint8Array,
  headerValue: string,
  options: HttpWebhookSignatureOptions,
): HttpWebhookSignatureResult {
  let rawTimestamp: string | undefined;
  const candidates: string[] = [];
  for (const field of headerValue.split(",")) {
    const eq = field.indexOf("=");
    if (eq === -1) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === "t") {
      rawTimestamp = value;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }

  if (
    rawTimestamp === undefined ||
    !/^\d+$/.test(rawTimestamp) ||
    candidates.length === 0
  ) {
    return { ok: false, reason: "invalid signature" };
  }

  const toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parseInt(rawTimestamp, 10)) > toleranceSec) {
    return { ok: false, reason: "signature expired" };
  }

  // Chained update() streams `<raw t>.<raw body>` into the HMAC without
  // building an intermediate concatenated buffer (and without a string
  // round-trip that could mangle a non-UTF-8-clean body).
  const expected = createHmac("sha256", options.secret)
    .update(`${rawTimestamp}.`)
    .update(rawBody)
    .digest("hex");
  return candidates.some(
    (candidate) =>
      candidate.length === HEX_DIGEST_LENGTH["hmac-sha256-hex"] &&
      timingSafeStringEqual(expected, candidate.toLowerCase()),
  )
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}
