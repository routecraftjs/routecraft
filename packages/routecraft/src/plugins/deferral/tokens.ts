import { createHmac, randomBytes } from "node:crypto";
import { rcError } from "../../error.ts";
import { timingSafeStringEqual } from "../../auth/timing-safe.ts";
import type {
  ResumeTokenPayload,
  ResumeTokenSigning,
  SigningSecretSource,
} from "../../kernel/continuation/port.ts";

/**
 * Environment variable read for the resume-token signing secret when the
 * context does not configure one explicitly.
 */
export const DEFERRAL_SECRET_ENV = "ROUTECRAFT_DEFERRAL_SECRET";

/** Token format version, so a future format change is detectable rather than silent. */
const TOKEN_VERSION = 1;
/**
 * Mints and verifies resume tokens for one context.
 *
 * HMAC-SHA256 over a compact JSON payload, encoded base64url so a token
 * survives a URL, an email body, and a chat message without escaping.
 */
export class ResumeTokenSigner implements ResumeTokenSigning {
  readonly #secret: Buffer;

  /**
   * How the secret was obtained. Surfaced so the context can log it once at
   * startup: an operator seeing `ephemeral` in production has a
   * misconfiguration, and that is worth being able to spot.
   */
  readonly source: SigningSecretSource;

  constructor(secret: string | Buffer, source: SigningSecretSource) {
    this.#secret =
      typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
    this.source = source;
  }

  /**
   * Mint a token for a deferral id.
   *
   * Callable BEFORE the deferring step runs, which is what lets a
   * notification step earlier in the pipeline put a working resume link in
   * the message it sends. Nothing about the deferred exchange is needed to
   * sign: the deferral id is derivable from the exchange (see
   * {@link deferralIdFor}), and the token carries no claims of its own.
   *
   * @param id - The deferral id this token will resume.
   * @param now - Mint timestamp, injectable for deterministic tests.
   * @param sub - The call this credential belongs to, when the deferring
   *   step can raise several at once. See {@link ResumeTokenPayload.sub}.
   */
  mint(id: string, now: Date = new Date(), sub?: string): string {
    // `verify` refuses a zero-length `sub`, so minting one would produce a
    // credential that provably never verifies and then reports itself as a
    // forgery (`RC5041`), pointing at the holder rather than at the call
    // site that asked for a binding it did not have.
    if (sub !== undefined && sub.length === 0) {
      throw rcError("RC5003", undefined, {
        message:
          "Cannot mint a resume token bound to an empty call binding: the binding must name the call this credential belongs to.",
      });
    }
    const payload: ResumeTokenPayload = {
      id,
      iat: now.getTime(),
      ...(sub !== undefined ? { sub } : {}),
    };
    const body = encode(JSON.stringify({ v: TOKEN_VERSION, ...payload }));
    return `${body}.${this.#sign(body)}`;
  }

  /**
   * Verify a token and return what it names.
   *
   * @param token - The token as presented by the resume ingress.
   * @returns The verified payload.
   * @throws RC5041 when the token is malformed, carries an unknown format
   *   version, or fails signature verification. The three are deliberately
   *   one error: telling a caller which of them failed tells an attacker
   *   how far a forgery got.
   */
  verify(token: string): ResumeTokenPayload {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) throw reject();
    const body = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    if (!timingSafeStringEqual(this.#sign(body), signature)) throw reject();

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw reject();
    }
    // `JSON.parse("null")` yields null, whose property read would escape as a
    // TypeError rather than the RC5041 this method's contract promises.
    if (parsed === null || typeof parsed !== "object") throw reject();
    const claims = parsed as {
      v?: unknown;
      id?: unknown;
      iat?: unknown;
      sub?: unknown;
    };
    if (
      claims.v !== TOKEN_VERSION ||
      typeof claims.id !== "string" ||
      claims.id.length === 0 ||
      typeof claims.iat !== "number" ||
      (claims.sub !== undefined &&
        (typeof claims.sub !== "string" || claims.sub.length === 0))
    ) {
      throw reject();
    }
    return {
      id: claims.id,
      iat: claims.iat,
      ...(typeof claims.sub === "string" ? { sub: claims.sub } : {}),
    };
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#secret)
      .update(body, "utf8")
      .digest("base64url");
  }
}

/**
 * Options accepted by {@link resolveSigningSecret}.
 */
export interface SigningSecretOptions {
  /** Secret supplied directly on `deferral: { secret }`. */
  secret?: string | undefined;
  /** Environment to read, injectable for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Allow minting an ephemeral in-memory key when nothing is configured.
   * Set by `testContext()` and by development mode. Never set in
   * production: an ephemeral key means every resume token becomes
   * unverifiable the moment the process restarts, which is precisely the
   * restart the feature exists to survive.
   */
  allowEphemeral?: boolean;
}

/**
 * Resolve the resume-token signing secret for a context.
 *
 * Configuration order is explicit value, then environment, then (only when
 * permitted) an ephemeral key. There is deliberately no fourth option: the
 * secret is never generated INTO the store, because a store compromise must
 * not also yield the ability to forge resume tokens, and because a
 * store-resident key stops working the moment a second node appears.
 *
 * @throws RC5040 when no secret is configured and ephemeral keys are not
 *   permitted. Raised while the context is being built, not on the first
 *   defer, so a missing secret is a startup failure rather than a
 *   production surprise on the first large payout.
 *
 * @internal
 */
export function resolveSigningSecret(
  options: SigningSecretOptions = {},
): ResumeTokenSigner {
  const configured = options.secret?.trim();
  if (configured) {
    return new ResumeTokenSigner(assertStrong(configured, "config"), "config");
  }

  const fromEnv = (options.env ?? process.env)[DEFERRAL_SECRET_ENV]?.trim();
  if (fromEnv) {
    return new ResumeTokenSigner(assertStrong(fromEnv, "env"), "env");
  }

  if (options.allowEphemeral) {
    return new ResumeTokenSigner(randomBytes(32), "ephemeral");
  }

  throw rcError("RC5040", undefined, {
    message: `No resume-token signing secret is configured. Set ${DEFERRAL_SECRET_ENV}, or pass deferral: { secret } to defineConfig.`,
  });
}

/**
 * Minimum signing-secret length, in bytes.
 *
 * A resume token is a bearer capability, and any holder of one token has an
 * offline oracle: body plus HMAC, unlimited guesses, nothing to rate limit.
 * A dictionary-strength secret falls in seconds, after which an attacker
 * mints a token for any deferral id, and ids are derived from the exchange
 * id rather than being a second secret. 32 bytes is the SHA-256 digest
 * size, which RFC 2104 gives as the recommended minimum HMAC key length.
 */
const MIN_SECRET_BYTES = 32;

/**
 * Reject a secret too weak to resist offline guessing, at resolution time
 * where the failure is already a startup error rather than a runtime one.
 *
 * @internal
 */
function assertStrong(secret: string, source: string): string {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MIN_SECRET_BYTES) {
    throw rcError("RC5040", undefined, {
      message: `The resume-token signing secret from ${source} is ${bytes} bytes; at least ${MIN_SECRET_BYTES} are required. Generate one with: openssl rand -base64 32`,
    });
  }
  return secret;
}

/** @internal */
function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** @internal */
function reject(): Error {
  return rcError("RC5041", undefined, {
    message: "Resume token rejected: malformed or signature mismatch.",
  });
}
