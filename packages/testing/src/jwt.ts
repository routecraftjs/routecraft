import { createHmac } from "node:crypto";

/** Defaults matching the validator options the suites configure. */
const DEFAULT_ISSUER = "https://idp.test";
const DEFAULT_AUDIENCE = "https://api.test";

export interface SignHs256Options {
  secret: string;
  /** Claims layered over the defaults. Pass `exp` to override the expiry. */
  claims?: Record<string, unknown>;
  /** Header overrides, so a suite can pin a rejected `alg`. */
  header?: Record<string, unknown>;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Sign an HS256 compact JWT for tests, without pulling in a JWT library.
 *
 * Shared because five suites across two packages had grown their own copy of
 * this, each hardcoding issuer, audience and expiry inline. A change to what
 * the validator accepts (a required `kid`, an algorithm allowlist) had to be
 * chased through all five, and the ones left behind failed with an opaque 401
 * rather than a clear signal.
 */
export function signHs256(options: SignHs256Options): string {
  const header = base64url(
    JSON.stringify({ alg: "HS256", typ: "JWT", ...(options.header ?? {}) }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: DEFAULT_ISSUER,
      aud: DEFAULT_AUDIENCE,
      sub: "operator",
      exp: Math.floor(Date.now() / 1000) + 60,
      ...(options.claims ?? {}),
    }),
  );
  const signature = createHmac("sha256", options.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
