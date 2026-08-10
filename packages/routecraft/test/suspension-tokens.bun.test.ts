import { describe, expect, test } from "bun:test";
import { SUSPENSION_SECRET_ENV } from "../src/index.ts";
// Engine machinery, reached through the intra-package barrel.
import {
  ResumeTokenSigner,
  resolveSigningSecret,
  suspensionIdFor,
} from "../src/suspension/index.ts";

// At least 32 bytes: resolveSigningSecret enforces a floor, and a
// fixture below it would be testing the guard rather than the signer.
const SECRET = "test-signing-secret-padded-to-32-bytes";

describe("resume tokens", () => {
  /**
   * @case A minted token verifies back to the suspension it names
   * @preconditions A signer with a fixed secret mints a token for one id
   * @expectedResult verify returns that id and the mint timestamp
   */
  test("mints a token that verifies back to its suspension", () => {
    const signer = new ResumeTokenSigner(SECRET, "config");
    const at = new Date("2026-08-10T09:00:00.000Z");

    const payload = signer.verify(signer.mint("sus-1", at));

    expect(payload.id).toBe("sus-1");
    expect(payload.iat).toBe(at.getTime());
  });

  /**
   * @case A token is minted before the suspend step runs
   * @preconditions Only a suspension id is available, no stored record
   * @expectedResult Minting succeeds, which is what lets a notification step
   *   ahead of the suspend send a working resume link
   */
  test("needs nothing but an id to mint", () => {
    const signer = new ResumeTokenSigner(SECRET, "config");
    const id = suspensionIdFor("ex-1", 0);
    expect(signer.verify(signer.mint(id)).id).toBe(id);
  });

  /**
   * @case Successive parks of one exchange get distinct ids
   * @preconditions The same exchange id at sequence 0 and 1
   * @expectedResult The ids differ, so a second approval does not collide
   *   with the first in the store
   */
  test("derives a distinct id per suspension of the same exchange", () => {
    expect(suspensionIdFor("ex-1", 0)).toBe("ex-1~0");
    expect(suspensionIdFor("ex-1", 1)).not.toBe(suspensionIdFor("ex-1", 0));
  });

  /**
   * @case Two unrelated exchanges never derive the same suspension id
   * @preconditions An exchange whose id already ends in the separator and a
   *   sequence number, parked first, against another exchange parking for a
   *   second time
   * @expectedResult The ids differ. Colliding would let one parked exchange
   *   overwrite the other in the store, losing an approval in flight
   */
  test("does not collide when an exchange id ends in a sequence suffix", () => {
    expect(suspensionIdFor("ex-1~1", 0)).not.toBe(suspensionIdFor("ex-1", 1));
  });

  /**
   * @case A tampered payload does not verify
   * @preconditions A token whose body is swapped for another suspension id
   * @expectedResult verify throws RC5041
   */
  test("rejects a token whose payload was swapped", () => {
    const signer = new ResumeTokenSigner(SECRET, "config");
    const genuine = signer.mint("sus-1");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, id: "sus-2", iat: Date.now() }),
      "utf8",
    ).toString("base64url");

    expect(() => signer.verify(`${forged}.${genuine.split(".")[1]}`)).toThrow(
      expect.objectContaining({ rc: "RC5041" }),
    );
  });

  /**
   * @case A token signed with a different secret is not accepted
   * @preconditions Two signers with different secrets
   * @expectedResult The second signer rejects the first's token with RC5041
   */
  test("rejects a token signed with another secret", () => {
    const minted = new ResumeTokenSigner(SECRET, "config").mint("sus-1");
    const other = new ResumeTokenSigner(
      "a-different-secret-also-32-bytes-long",
      "config",
    );

    expect(() => other.verify(minted)).toThrow(
      expect.objectContaining({ rc: "RC5041" }),
    );
  });

  /**
   * @case Garbage in the token slot fails as a rejection, not a crash
   * @preconditions Strings that are not tokens at all
   * @expectedResult Each throws RC5041
   */
  test("rejects malformed tokens", () => {
    const signer = new ResumeTokenSigner(SECRET, "config");
    for (const candidate of ["", "nodot", ".", "a.b", "....."]) {
      expect(() => signer.verify(candidate)).toThrow(
        expect.objectContaining({ rc: "RC5041" }),
      );
    }
  });

  /**
   * @case Token text survives a URL, an email, and a chat message
   * @preconditions A token minted for an id containing a separator
   * @expectedResult The encoded form is URL-safe base64url plus one dot
   */
  test("emits a transport-safe token", () => {
    const token = new ResumeTokenSigner(SECRET, "config").mint("ex-1#2");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("signing secret resolution", () => {
  /**
   * @case An explicitly configured secret wins
   * @preconditions Both a config secret and an environment secret are present
   * @expectedResult The signer reports the config source
   */
  test("prefers the configured secret over the environment", () => {
    const signer = resolveSigningSecret({
      secret: SECRET,
      env: { [SUSPENSION_SECRET_ENV]: "from-env-secret-padded-to-32-bytes" },
    });
    expect(signer.source).toBe("config");
  });

  /**
   * @case The environment is the recommended source
   * @preconditions Only the environment variable is set
   * @expectedResult The signer reports the env source and can mint
   */
  test("reads the secret from the environment", () => {
    const signer = resolveSigningSecret({
      env: { [SUSPENSION_SECRET_ENV]: "from-env-secret-padded-to-32-bytes" },
    });
    expect(signer.source).toBe("env");
    expect(signer.verify(signer.mint("sus-1")).id).toBe("sus-1");
  });

  /**
   * @case A blank secret is treated as absent, not as a valid key
   * @preconditions Whitespace-only values in both config and environment
   * @expectedResult Resolution fails with RC5040 rather than signing with nothing
   */
  test("treats a blank secret as missing", () => {
    expect(() =>
      resolveSigningSecret({
        secret: "   ",
        env: { [SUSPENSION_SECRET_ENV]: " " },
      }),
    ).toThrow(expect.objectContaining({ rc: "RC5040" }));
  });

  /**
   * @case A production context without a secret fails at startup
   * @preconditions No secret anywhere and ephemeral keys not permitted
   * @expectedResult RC5040, naming the environment variable to set
   */
  test("refuses to start without a secret", () => {
    expect(() => resolveSigningSecret({ env: {} })).toThrow(
      expect.objectContaining({ rc: "RC5040" }),
    );
    expect(() => resolveSigningSecret({ env: {} })).toThrow(
      new RegExp(SUSPENSION_SECRET_ENV),
    );
  });

  /**
   * @case A guessable secret is refused at startup
   * @preconditions A short secret, the kind copied out of an error message
   *   to get past a startup failure
   * @expectedResult RC5040 naming the byte count, because a resume token
   *   holder can guess the secret offline with no rate limit
   */
  test("refuses a secret below the strength floor", () => {
    expect(() => resolveSigningSecret({ secret: "changeme", env: {} })).toThrow(
      expect.objectContaining({ rc: "RC5040" }),
    );
    expect(() =>
      resolveSigningSecret({ env: { [SUSPENSION_SECRET_ENV]: "changeme" } }),
    ).toThrow(/at least 32/);
  });

  /**
   * @case Tests and local iteration need no setup
   * @preconditions No secret, ephemeral keys permitted
   * @expectedResult A working signer whose source is reported as ephemeral
   */
  test("mints an ephemeral key when permitted", () => {
    const signer = resolveSigningSecret({ env: {}, allowEphemeral: true });
    expect(signer.source).toBe("ephemeral");
    expect(signer.verify(signer.mint("sus-1")).id).toBe("sus-1");
  });

  /**
   * @case An ephemeral key does not survive the process it was minted in
   * @preconditions Two ephemeral signers, standing in for two process lifetimes
   * @expectedResult The second cannot verify the first's token, which is why
   *   ephemeral keys are refused outside development
   */
  test("ephemeral keys are per-process", () => {
    const first = resolveSigningSecret({ env: {}, allowEphemeral: true });
    const second = resolveSigningSecret({ env: {}, allowEphemeral: true });

    expect(() => second.verify(first.mint("sus-1"))).toThrow(
      expect.objectContaining({ rc: "RC5041" }),
    );
  });
});
