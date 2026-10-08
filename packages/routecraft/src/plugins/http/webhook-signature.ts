import {
  createHmac,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { timingSafeStringEqual } from "../../auth/timing-safe";

const SCHEMES = [
  "hmac-sha256-hex",
  "hmac-sha1-hex",
  "stripe-timestamped",
  "standard-webhooks",
  "ed25519",
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
 * - `"standard-webhooks"`: the [Standard Webhooks](https://www.standardwebhooks.com/)
 *   format, sent by Resend, Bird and Svix among others. Reads the three
 *   headers the specification fixes (`webhook-id`, `webhook-timestamp`,
 *   `webhook-signature`), signs `<id>.<timestamp>.<raw body>` with the
 *   base64-decoded secret, and admits when any space-separated `v1,` entry
 *   matches. Covers the symmetric half of the specification only:
 *   asymmetric `v1a` (ed25519) entries are skipped like any other
 *   non-`v1` version.
 * - `"ed25519"`: an Ed25519 signature over the raw body, verified against
 *   the provider's public key rather than a shared secret. Telnyx
 *   (`telnyx-signature-ed25519` over `<telnyx-timestamp>|<raw body>`) and
 *   Discord (`x-signature-ed25519` over `<x-signature-timestamp><raw body>`)
 *   sign this way. The signature header carries the 64-byte signature in
 *   base64 or hex; when `timestampHeader` is set the signed payload is
 *   `<timestamp><separator><raw body>` and the timestamp must be within
 *   `toleranceSec` of the server clock.
 */
export type HttpWebhookSignatureScheme = (typeof SCHEMES)[number];

/** The field every scheme with a timestamp takes. */
interface HttpWebhookSignatureCommonOptions {
  /**
   * Maximum allowed clock skew, in seconds, between the signature's
   * embedded timestamp and the server clock. Used by
   * `"stripe-timestamped"`, `"standard-webhooks"` and `"ed25519"` with a
   * `timestampHeader`. Defaults to 300.
   */
  toleranceSec?: number;
}

/** Fields every secret-keyed scheme takes. */
interface HttpWebhookSignatureOptionsBase extends HttpWebhookSignatureCommonOptions {
  /** Shared secret the provider signs with. */
  secret: string;
  /**
   * Literal prefix stripped from the header value before comparison, e.g.
   * `"sha256="` for GitHub. A header value that does not start with the
   * prefix is an invalid signature. Ignored by `"stripe-timestamped"` and
   * `"standard-webhooks"`, which have their own field formats.
   */
  prefix?: string;
}

/**
 * The three secret-keyed schemes that read one configured header. `header`
 * is required: nothing in these formats fixes a header name, so there is no
 * default that would be right more often than it is wrong.
 */
export interface HttpWebhookSignatureHeaderOptions extends HttpWebhookSignatureOptionsBase {
  /** Request header carrying the signature (e.g. `"x-hub-signature-256"`). Case-insensitive. */
  header: string;
  /** Signature scheme. See {@link HttpWebhookSignatureScheme}. */
  scheme: Exclude<HttpWebhookSignatureScheme, "standard-webhooks" | "ed25519">;
}

/**
 * Ed25519. A public key in place of a secret, because the provider signs
 * with a key it never shares: a leaked verifier configuration lets nobody
 * forge a delivery. The header names stay configurable because every
 * provider on this scheme picks its own, and the separator between the
 * timestamp and the body is the one other thing they disagree on.
 */
export interface HttpEd25519SignatureOptions extends HttpWebhookSignatureCommonOptions {
  scheme: "ed25519";
  /**
   * The provider's Ed25519 public key: the raw 32 bytes in base64 (44
   * characters) or hex (64 characters), as provider dashboards show it, or
   * an SPKI PEM block.
   */
  publicKey: string;
  /** Request header carrying the signature, base64 or hex. Case-insensitive. */
  header: string;
  /**
   * Request header carrying the unix-seconds timestamp the provider signed
   * with the body. When set, the signed payload is
   * `<timestamp><separator><raw body>` and a timestamp outside
   * `toleranceSec` rejects `signature expired`. When absent, the raw body
   * alone is signed and replay is the route's to bound.
   */
  timestampHeader?: string;
  /**
   * Text between the timestamp and the body in the signed payload. Telnyx
   * signs `<timestamp>|<body>`; Discord signs `<timestamp><body>`. Defaults
   * to the empty string. Ignored without `timestampHeader`.
   */
  separator?: string;
  /** Never set: this scheme verifies against `publicKey`. */
  secret?: never;
  /** Never set: the signature header carries the bare signature. */
  prefix?: never;
}

/**
 * Standard Webhooks. The specification fixes all three header names, so a
 * route configures a secret and nothing else. There is deliberately no
 * per-header override: the id and timestamp names are read from the
 * specification, so renaming only the signature header would build a route
 * that constructs cleanly and then rejects every live delivery.
 */
export interface HttpStandardWebhooksSignatureOptions extends HttpWebhookSignatureOptionsBase {
  scheme: "standard-webhooks";
  /**
   * Never set. Declared so the refusal survives a config object that is not
   * an object literal, where excess-property checking does not apply.
   */
  header?: never;
}

/**
 * Declarative webhook-signature verification for `http({...})` sources.
 * When configured, the plugin verifies the raw request bytes against the
 * signature header and rejects 401 before any route step runs, so HMAC
 * comparison never has to be hand-rolled in a `.filter()`.
 *
 * For providers whose scheme is not covered here, opt in to
 * `http({ rawBody: true })` instead and verify in a route step against
 * `routecraft.http.rawBody`.
 */
export type HttpWebhookSignatureOptions =
  | HttpWebhookSignatureHeaderOptions
  | HttpStandardWebhooksSignatureOptions
  | HttpEd25519SignatureOptions;

/**
 * Bounded rejection reasons, returned to clients in the 401 body and emitted
 * as the `reason` field on `auth:rejected`. Kept a closed vocabulary per the
 * security standard: never derived from `err.message` free text.
 */
export type HttpWebhookSignatureRejection =
  "missing signature header" | "invalid signature" | "signature expired";

export type HttpWebhookSignatureResult =
  { ok: true } | { ok: false; reason: HttpWebhookSignatureRejection };

const DEFAULT_TOLERANCE_SEC = 300;

/** Unix seconds as the sender wrote them; never a re-serialised parse. */
const UNIX_SECONDS = /^\d+$/;

/**
 * The replay bound every timestamped scheme applies: true when the signed
 * timestamp sits further from the server clock than the tolerance allows.
 * Shared rather than copied because the schemes are documented as bounding
 * replay the same way, so they have one reason to change.
 */
function outsideTolerance(
  rawTimestamp: string,
  toleranceSec: number | undefined,
): boolean {
  const tolerance = toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - parseInt(rawTimestamp, 10)) > tolerance;
}

/**
 * RFC 7230 header-name token. `Headers.get()` throws a TypeError on names
 * outside this set, so an invalid name must be rejected at construction
 * rather than exploding at the first delivery.
 */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** True when `value` is a string usable as a header name. */
function isHeaderName(value: unknown): value is string {
  return typeof value === "string" && HEADER_TOKEN.test(value);
}

/** Exact hex-digest shape per scheme, used to reject malformed candidates before hashing. */
const HEX_DIGEST_PATTERN = {
  "hmac-sha256-hex": /^[0-9a-fA-F]{64}$/,
  "hmac-sha1-hex": /^[0-9a-fA-F]{40}$/,
} as const;

/** Base64 of a 32-byte digest: 43 symbols and one pad character. */
const BASE64_SHA256_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/** A 64-byte Ed25519 signature: 86 base64 symbols and two pad characters, or 128 hex digits. */
const ED25519_SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const ED25519_SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/;

/** A raw 32-byte Ed25519 public key as dashboards show it: base64 or hex. */
const ED25519_KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The SPKI header for an Ed25519 public key (RFC 8410), so a raw 32-byte key
 * can be handed to `createPublicKey` as DER. Providers publish the raw key;
 * Node wants the wrapped one.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Key objects by the configured text, built once per configured key rather
 * than per delivery. Bounded by the number of distinct `publicKey` values a
 * process configures, which is the number of Ed25519-signed routes it has.
 */
const ED25519_KEYS = new Map<string, KeyObject>();

/**
 * The provider's public key as a `KeyObject`, or `null` when the text is not
 * an Ed25519 public key in any accepted form. Never throws: the result
 * decides a construction-time refusal, and a delivery-time miss reads as an
 * invalid signature.
 */
function ed25519PublicKey(text: string): KeyObject | null {
  const cached = ED25519_KEYS.get(text);
  if (cached !== undefined) return cached;
  const trimmed = text.trim();
  try {
    let key: KeyObject;
    if (trimmed.startsWith("-----BEGIN")) {
      key = createPublicKey(trimmed);
    } else {
      const raw = ED25519_KEY_HEX_PATTERN.test(trimmed)
        ? Buffer.from(trimmed, "hex")
        : BASE64_SHA256_PATTERN.test(trimmed)
          ? Buffer.from(trimmed, "base64")
          : null;
      if (raw === null || raw.length !== 32) return null;
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
        format: "der",
        type: "spki",
      });
    }
    if (key.asymmetricKeyType !== "ed25519") return null;
    ED25519_KEYS.set(text, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * The base64 alphabet a Standard Webhooks secret may use, padding already
 * stripped. Both the standard and the URL-safe alphabet are accepted because
 * `Buffer.from(x, "base64")` decodes either.
 */
const BASE64_SECRET_PATTERN = /^[A-Za-z0-9+/\-_]+$/;

/**
 * The three header names the Standard Webhooks specification fixes. None is
 * configurable: a sender that renamed them would not be sending Standard
 * Webhooks, and renaming only one of the three would build a route that
 * constructs cleanly and then rejects every live delivery.
 */
const STANDARD_WEBHOOKS_SIGNATURE_HEADER = "webhook-signature";
const STANDARD_WEBHOOKS_ID_HEADER = "webhook-id";
const STANDARD_WEBHOOKS_TIMESTAMP_HEADER = "webhook-timestamp";

/** Identification prefix on a Standard Webhooks symmetric secret. */
const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";

/**
 * The base64 body of a Standard Webhooks secret, with the identification
 * prefix stripped when present. The reference implementation accepts the
 * secret either way, so a route that pastes the value straight out of a
 * provider dashboard works whether or not the dashboard shows the prefix.
 */
function standardWebhooksSecretBody(secret: string): string {
  return secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : secret;
}

/**
 * Render an untrusted config value for an error message without letting the
 * renderer itself throw (JSON.stringify rejects BigInt and circular values,
 * which are exactly the malformed inputs being reported).
 */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unrepresentable value>";
    }
  }
}

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
    return `invalid signature options ${describeValue(options)}. Pass { header, secret, scheme }.`;
  }
  if (!SCHEMES.includes(options.scheme)) {
    return `invalid signature.scheme ${describeValue(options.scheme)}. Allowed: ${SCHEMES.map((s) => `"${s}"`).join(", ")}.`;
  }
  // Every scheme but standard-webhooks needs a header name, because none of
  // their formats fixes one. Standard Webhooks takes no header at all.
  if (options.scheme !== "standard-webhooks" && !isHeaderName(options.header)) {
    return `invalid signature.header ${describeValue(options.header)}. Pass a legal HTTP header name (RFC 7230 token, e.g. "x-hub-signature-256").`;
  }
  if (options.scheme === "ed25519") {
    // The key is parsed here rather than at the first delivery for the same
    // reason the Standard Webhooks secret is decoded here: a key that cannot
    // be parsed would otherwise reject every delivery as an invalid
    // signature, which reads as the sender's fault rather than the config's.
    if (
      typeof options.publicKey !== "string" ||
      ed25519PublicKey(options.publicKey) === null
    ) {
      return `invalid signature.publicKey. Pass the provider's Ed25519 public key: the raw 32 bytes in base64 or hex, or an SPKI PEM block.`;
    }
    if (
      options.timestampHeader !== undefined &&
      !isHeaderName(options.timestampHeader)
    ) {
      return `invalid signature.timestampHeader ${describeValue(options.timestampHeader)}. Pass a legal HTTP header name (RFC 7230 token, e.g. "telnyx-timestamp").`;
    }
    if (
      options.separator !== undefined &&
      typeof options.separator !== "string"
    ) {
      return `invalid signature.separator ${describeValue(options.separator)}. Pass a string (e.g. "|").`;
    }
  } else if (typeof options.secret !== "string" || options.secret === "") {
    return "invalid signature.secret. Pass the provider's non-empty signing secret.";
  }
  if (options.scheme === "standard-webhooks") {
    // Decoded here rather than at the first delivery: a secret that cannot
    // be decoded would otherwise reject every delivery as an invalid
    // signature, which reads as the sender's fault rather than the config's.
    const body = standardWebhooksSecretBody(options.secret).replace(/=+$/, "");
    // Padding is not required: `Buffer.from(x, "base64")` decodes an unpadded
    // secret, and a dashboard or an env pipeline that trimmed the "=" would
    // otherwise be told its correct secret is malformed. A length of 1 more
    // than a multiple of 4 encodes no whole byte, so it is still refused.
    if (
      body === "" ||
      body.length % 4 === 1 ||
      !BASE64_SECRET_PATTERN.test(body)
    ) {
      return `invalid signature.secret. A "standard-webhooks" secret is base64, optionally prefixed with "${STANDARD_WEBHOOKS_SECRET_PREFIX}" (e.g. "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw").`;
    }
  }
  if (
    options.scheme !== "ed25519" &&
    options.prefix !== undefined &&
    typeof options.prefix !== "string"
  ) {
    return `invalid signature.prefix ${describeValue(options.prefix)}. Pass a string (e.g. "sha256=").`;
  }
  if (
    options.toleranceSec !== undefined &&
    (typeof options.toleranceSec !== "number" ||
      !Number.isFinite(options.toleranceSec) ||
      options.toleranceSec <= 0)
  ) {
    return `invalid signature.toleranceSec ${describeValue(options.toleranceSec)}. Pass a positive number of seconds.`;
  }
  return null;
}

/**
 * Verify a webhook signature against the raw request bytes.
 *
 * Takes the request's whole header set rather than one pre-read value,
 * because a scheme decides for itself which headers it needs:
 * `"standard-webhooks"` reads three.
 *
 * All comparisons are timing-safe via the shared {@link timingSafeStringEqual}
 * (length-guarded `timingSafeEqual`, also used by the JWT HMAC validator).
 * Hex comparison is case-insensitive: providers disagree on digest casing
 * and hex case carries no information. Candidates that do not match the
 * scheme's exact hex-digest shape are rejected before any HMAC is computed, so floods of
 * malformed signatures do not pay a full-body hash. The verifier never
 * throws for untrusted input; every failure mode maps to a bounded
 * {@link HttpWebhookSignatureRejection}.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  headers: Headers,
  options: HttpWebhookSignatureOptions,
): HttpWebhookSignatureResult {
  // Dispatched on the scheme before any header is read, so each scheme reads
  // the headers it fixes and the union stays narrowed.
  if (options.scheme === "standard-webhooks") {
    return verifyStandardWebhooks(rawBody, headers, options);
  }
  if (options.scheme === "ed25519") {
    return verifyEd25519(rawBody, headers, options);
  }

  const headerValue = headers.get(options.header);
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
  if (!HEX_DIGEST_PATTERN[options.scheme].test(candidate)) {
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
  options: HttpWebhookSignatureHeaderOptions,
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
    !UNIX_SECONDS.test(rawTimestamp) ||
    candidates.length === 0
  ) {
    return { ok: false, reason: "invalid signature" };
  }

  // Drop candidates whose length cannot match a sha256 hex digest BEFORE
  // hashing, so the module's no-full-body-hash-for-malformed-signatures
  // guarantee holds for this scheme too.
  const viable = candidates.filter((candidate) =>
    HEX_DIGEST_PATTERN["hmac-sha256-hex"].test(candidate),
  );
  if (viable.length === 0) {
    return { ok: false, reason: "invalid signature" };
  }

  if (outsideTolerance(rawTimestamp, options.toleranceSec)) {
    return { ok: false, reason: "signature expired" };
  }

  // Chained update() streams `<raw t>.<raw body>` into the HMAC without
  // building an intermediate concatenated buffer (and without a string
  // round-trip that could mangle a non-UTF-8-clean body).
  const expected = createHmac("sha256", options.secret)
    .update(`${rawTimestamp}.`)
    .update(rawBody)
    .digest("hex");
  return viable.some((candidate) =>
    timingSafeStringEqual(expected, candidate.toLowerCase()),
  )
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/**
 * Verify the [Standard Webhooks](https://www.standardwebhooks.com/) format.
 *
 * The signed payload is `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed
 * on the base64-decoded secret. The signature header is a space-separated
 * list of `<version>,<base64>` entries, several of which appear during key
 * rotation; any `v1` entry that matches admits, and entries of another
 * version (the specification's asymmetric `v1a` among them) are skipped
 * rather than treated as failures.
 *
 * A delivery missing either fixed header is `missing signature header`
 * rather than `invalid signature`: nothing was presented to verify, which is
 * the same thing an absent signature header means.
 *
 * The raw header text is signed, never a re-serialised parse of it, for the
 * reason the Stripe scheme does the same: the sender signed the exact
 * characters it sent.
 */
function verifyStandardWebhooks(
  rawBody: Uint8Array,
  headers: Headers,
  options: HttpStandardWebhooksSignatureOptions,
): HttpWebhookSignatureResult {
  const headerValue = headers.get(STANDARD_WEBHOOKS_SIGNATURE_HEADER);
  if (headerValue === null || headerValue.trim() === "") {
    return { ok: false, reason: "missing signature header" };
  }
  const id = headers.get(STANDARD_WEBHOOKS_ID_HEADER);
  const rawTimestamp = headers.get(STANDARD_WEBHOOKS_TIMESTAMP_HEADER);
  if (
    id === null ||
    id.trim() === "" ||
    rawTimestamp === null ||
    rawTimestamp.trim() === ""
  ) {
    return { ok: false, reason: "missing signature header" };
  }
  if (!UNIX_SECONDS.test(rawTimestamp)) {
    return { ok: false, reason: "invalid signature" };
  }

  // Same pre-hash filter as the other schemes: a flood of malformed
  // signatures must not each pay a full-body HMAC.
  const viable: string[] = [];
  for (const entry of headerValue.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== "v1") continue;
    const candidate = entry.slice(comma + 1);
    if (BASE64_SHA256_PATTERN.test(candidate)) viable.push(candidate);
  }
  if (viable.length === 0) {
    return { ok: false, reason: "invalid signature" };
  }

  if (outsideTolerance(rawTimestamp, options.toleranceSec)) {
    return { ok: false, reason: "signature expired" };
  }

  const key = Buffer.from(standardWebhooksSecretBody(options.secret), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${rawTimestamp}.`)
    .update(rawBody)
    .digest("base64");
  return viable.some((candidate) => timingSafeStringEqual(expected, candidate))
    ? { ok: true }
    : { ok: false, reason: "invalid signature" };
}

/**
 * Verify an Ed25519 signature over `<timestamp><separator><raw body>`, or
 * over the raw body alone when the scheme is configured without a
 * `timestampHeader`.
 *
 * A candidate that is not the shape of a 64-byte signature is rejected
 * before any verification, as the other schemes do before any HMAC. The
 * timestamp is checked before the signature for the same reason: an expired
 * delivery pays no public-key operation. The raw header text is what the
 * sender signed, so it enters the payload unparsed. Signature verification
 * is not a secret comparison, so no timing-safe equality is involved; the
 * public key is public.
 */
function verifyEd25519(
  rawBody: Uint8Array,
  headers: Headers,
  options: HttpEd25519SignatureOptions,
): HttpWebhookSignatureResult {
  const headerValue = headers.get(options.header);
  if (headerValue === null || headerValue.trim() === "") {
    return { ok: false, reason: "missing signature header" };
  }
  let rawTimestamp: string | undefined;
  if (options.timestampHeader !== undefined) {
    const value = headers.get(options.timestampHeader);
    if (value === null || value.trim() === "") {
      return { ok: false, reason: "missing signature header" };
    }
    rawTimestamp = value.trim();
    if (!UNIX_SECONDS.test(rawTimestamp)) {
      return { ok: false, reason: "invalid signature" };
    }
  }

  const candidate = headerValue.trim();
  const signature = ED25519_SIGNATURE_BASE64_PATTERN.test(candidate)
    ? Buffer.from(candidate, "base64")
    : ED25519_SIGNATURE_HEX_PATTERN.test(candidate)
      ? Buffer.from(candidate, "hex")
      : null;
  if (signature === null || signature.length !== 64) {
    return { ok: false, reason: "invalid signature" };
  }

  if (
    rawTimestamp !== undefined &&
    outsideTolerance(rawTimestamp, options.toleranceSec)
  ) {
    return { ok: false, reason: "signature expired" };
  }

  const key = ed25519PublicKey(options.publicKey);
  if (key === null) {
    return { ok: false, reason: "invalid signature" };
  }
  const prefix =
    rawTimestamp === undefined
      ? ""
      : `${rawTimestamp}${options.separator ?? ""}`;
  const message =
    prefix === ""
      ? rawBody
      : Buffer.concat([Buffer.from(prefix, "utf8"), rawBody]);
  let verified = false;
  try {
    verified = verifySignature(null, message, key, signature);
  } catch {
    verified = false;
  }
  return verified ? { ok: true } : { ok: false, reason: "invalid signature" };
}
