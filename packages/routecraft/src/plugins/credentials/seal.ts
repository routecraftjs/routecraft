import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { rcError } from "../../error.ts";

/**
 * Environment variable holding the key credentials are sealed with. Any
 * string works; one from a secret manager, at least 32 random bytes, is
 * what it is meant to be.
 */
export const CREDENTIALS_KEY_ENV = "ROUTECRAFT_CREDENTIALS_KEY";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals and opens values under one key with AES-256-GCM.
 *
 * The key is derived with HKDF rather than used as given, so an operator
 * can supply any string and the cipher still gets 32 uniform bytes. The
 * associated data binds a sealed value to where it belongs: a store record
 * to its owner, a seed to being a seed, so a ciphertext copied from one
 * place to another refuses to open.
 */
export interface CredentialSealer {
  seal(plaintext: string, context: string): string;
  /** @throws RC5070 when the value was sealed under another key or altered */
  open(sealed: string, context: string): string;
}

/** A sealer over `secret`. */
export function createSealer(secret: string): CredentialSealer {
  if (secret.length === 0) {
    throw rcError("RC5070", undefined, {
      message: `${CREDENTIALS_KEY_ENV} is set but empty.`,
    });
  }
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      "routecraft-credentials-v1",
      32,
    ),
  );
  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, body, cipher.getAuthTag()]).toString(
        "base64url",
      );
    },
    open(sealed, context) {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length < IV_BYTES + TAG_BYTES) throw unopenable(context);
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(body),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw unopenable(context);
      }
    },
  };
}

/** The sealer the environment's key gives, or undefined without one. */
export function sealerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CredentialSealer | undefined {
  const secret = env[CREDENTIALS_KEY_ENV];
  return secret === undefined ? undefined : createSealer(secret);
}

function unopenable(context: string): Error {
  return rcError("RC5070", undefined, {
    message: `A sealed credential (${context}) does not open under ${CREDENTIALS_KEY_ENV}: it was sealed under another key, or altered.`,
  });
}
