import { createHmac, timingSafeEqual } from "node:crypto";

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
export type HttpWebhookSignatureScheme =
  | "hmac-sha256-hex"
  | "hmac-sha1-hex"
  | "stripe-timestamped";

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

const SCHEMES: ReadonlySet<string> = new Set([
  "hmac-sha256-hex",
  "hmac-sha1-hex",
  "stripe-timestamped",
] satisfies HttpWebhookSignatureScheme[]);

const DEFAULT_TOLERANCE_SEC = 300;

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
  if (typeof options.header !== "string" || options.header.trim() === "") {
    return `invalid signature.header ${JSON.stringify(options.header)}. Pass the request header name carrying the signature.`;
  }
  if (typeof options.secret !== "string" || options.secret === "") {
    return "invalid signature.secret. Pass the provider's non-empty signing secret.";
  }
  if (!SCHEMES.has(options.scheme)) {
    return `invalid signature.scheme ${JSON.stringify(options.scheme)}. Allowed: "hmac-sha256-hex", "hmac-sha1-hex", "stripe-timestamped".`;
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
 * All comparisons are timing-safe: candidate and expected digests are
 * compared via `timingSafeEqual` behind an explicit length guard (a length
 * mismatch is an ordinary rejection, not an exception), mirroring the JWT
 * HMAC validator. The verifier never throws for untrusted input; every
 * failure mode maps to a bounded {@link HttpWebhookSignatureRejection}.
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

  const digest = options.scheme === "hmac-sha256-hex" ? "sha256" : "sha1";
  const expected = createHmac(digest, options.secret)
    .update(rawBody)
    .digest("hex");
  return hexEqualsTimingSafe(expected, candidate)
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/**
 * Verify Stripe's `t=<unix>,v1=<hex>` format. Multiple `v1` fields are
 * accepted (Stripe sends more than one during secret rotation); any match
 * admits. Unknown fields (`v0`, future versions) are ignored.
 */
function verifyStripeTimestamped(
  rawBody: Uint8Array,
  headerValue: string,
  options: HttpWebhookSignatureOptions,
): HttpWebhookSignatureResult {
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const field of headerValue.split(",")) {
    const eq = field.indexOf("=");
    if (eq === -1) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }

  if (timestamp === undefined || candidates.length === 0) {
    return { ok: false, reason: "invalid signature" };
  }

  const toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    return { ok: false, reason: "signature expired" };
  }

  // The signed payload is `<t>.<raw body>`, concatenated at the byte level
  // so a body that is not UTF-8-clean is never mangled by a string round-trip.
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`),
    Buffer.from(rawBody),
  ]);
  const expected = createHmac("sha256", options.secret)
    .update(signedPayload)
    .digest("hex");
  return candidates.some((candidate) =>
    hexEqualsTimingSafe(expected, candidate),
  )
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/**
 * Timing-safe string comparison with the explicit length guard
 * `timingSafeEqual` requires. Length itself is not secret here: hex digest
 * lengths are fixed per algorithm, so a length mismatch only reveals that
 * the client sent something malformed.
 */
function hexEqualsTimingSafe(expected: string, candidate: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const candidateBuf = Buffer.from(candidate);
  return (
    expectedBuf.length === candidateBuf.length &&
    timingSafeEqual(expectedBuf, candidateBuf)
  );
}
