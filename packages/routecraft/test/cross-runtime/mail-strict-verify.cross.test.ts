import { afterEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { promises as dns } from "node:dns";
import { dkimSign } from "mailauth/lib/dkim/sign.js";
import type { MailSender } from "../../src/adapters/mail/analysis.ts";
import { verifyStrict } from "../../src/adapters/mail/strict-verify.ts";

/**
 * Cross-runtime contract for strict mail verification.
 *
 * The two runtimes answer a TXT lookup in different shapes: Node groups the
 * strings of one record, Bun returns each string as a record of its own. The
 * verdict for a message signed with a key too long for one string must be the
 * same on both, so each arm stubs DNS with its own runtime's native shape and
 * asserts the same outcome.
 */

const KEY_NAME = "sel._domainkey.example.test";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mail strict verification across runtimes", () => {
  /**
   * @case A DKIM key over 255 bytes verifies on this runtime
   * @preconditions A message signed with a 2048-bit RSA key; DNS answers the key lookup in the shape this runtime's resolver returns
   * @expectedResult The DKIM verdict is pass
   */
  test("verifies a DKIM key published as several strings", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const strings =
      `v=DKIM1; k=rsa; p=${publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64")}`.match(/.{1,255}/g) ?? [];
    expect(strings.length).toBeGreaterThan(1);

    const message = Buffer.from(
      [
        "From: alice@example.test",
        "To: bob@example.test",
        "Subject: hello",
        "Date: Sat, 14 Nov 2026 10:00:00 +0000",
        "Message-ID: <1@example.test>",
        "",
        "hello",
        "",
      ].join("\r\n"),
    );
    const signed = await dkimSign(message, {
      signatureData: [
        {
          signingDomain: "example.test",
          selector: "sel",
          privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
        },
      ],
    });
    const source = Buffer.concat([Buffer.from(signed.signatures), message]);

    const onBun = typeof process.versions["bun"] === "string";
    vi.spyOn(dns, "resolve").mockImplementation((async (
      name: string,
      rrtype: string,
    ) => {
      if (name === KEY_NAME && rrtype === "TXT") {
        return onBun ? strings.map((part) => [part]) : [strings];
      }
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    }) as unknown as typeof dns.resolve);

    const sender: MailSender = {
      address: "alice@example.test",
      domain: "example.test",
      forwardType: "direct",
      forwardChain: [],
      trust: "unverified",
      reason: "",
      authentication: { dkim: "none", spf: "none", dmarc: "none", arc: "none" },
    };
    const verified = await verifyStrict(source, sender);

    expect(verified.authentication.dkim).toBe("pass");
  });
});
