import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { promises as dns } from "node:dns";
import { dkimSign } from "mailauth/lib/dkim/sign.js";
import type { MailSender } from "../src/adapters/mail/analysis.ts";
import {
  rejoinKeyRecord,
  verifyStrict,
} from "../src/adapters/mail/strict-verify.ts";

const KEY_NAME = "sel._domainkey.example.test";

/** The strings of one TXT record, cut at the 255 bytes a single string may hold. */
function txtStrings(value: string): string[] {
  return value.match(/.{1,255}/g) ?? [];
}

describe("rejoinKeyRecord", () => {
  /**
   * @case A key record the runtime split into one record per string is made whole
   * @preconditions A `_domainkey` TXT lookup answered as two single-string records, on a runtime that splits
   * @expectedResult One record holding both strings in order
   */
  test("joins the strings of a split key record", () => {
    expect(
      rejoinKeyRecord(KEY_NAME, "TXT", [["v=DKIM1; p=AAA"], ["BBB"]], true),
    ).toEqual([["v=DKIM1; p=AAA", "BBB"]]);
  });

  /**
   * @case Distinct TXT records at an apex stay separate records
   * @preconditions An apex TXT lookup answered with an SPF record and a site verification record, on a runtime that splits
   * @expectedResult The two records are returned untouched, so the SPF policy is not corrupted
   */
  test("leaves the records of any other name apart", () => {
    const records = [["v=spf1 -all"], ["site-verification=abc"]];

    expect(rejoinKeyRecord("example.test", "TXT", records, true)).toBe(records);
  });

  /**
   * @case A runtime that groups strings itself is left alone
   * @preconditions A `_domainkey` TXT lookup answered with two records, on a runtime that does not split
   * @expectedResult The records are returned untouched
   */
  test("changes nothing on a runtime that does not split", () => {
    const records = [["v=DKIM1; p=AAA", "BBB"], ["other"]];

    expect(rejoinKeyRecord(KEY_NAME, "TXT", records, false)).toBe(records);
  });

  /**
   * @case Only TXT answers are joined
   * @preconditions A `_domainkey` lookup of another record type
   * @expectedResult The answer is returned untouched
   */
  test("changes nothing for another record type", () => {
    const records = ["a.example.test", "b.example.test"];

    expect(rejoinKeyRecord(KEY_NAME, "CNAME", records, true)).toBe(records);
  });
});

describe("verifyStrict", () => {
  afterEach(() => {
    spyOn(dns, "resolve").mockRestore();
  });

  /**
   * @case A message signed with a key over 255 bytes verifies on Bun
   * @preconditions A DKIM signature made with a 2048-bit RSA key, whose TXT record DNS answers the way Bun does: each 255-byte string as its own record
   * @expectedResult The DKIM verdict is pass
   */
  test("verifies a DKIM key published as several strings", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const record = `v=DKIM1; k=rsa; p=${publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`;
    expect(record.length).toBeGreaterThan(255);

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

    spyOn(dns, "resolve").mockImplementation((async (
      name: string,
      rrtype: string,
    ) => {
      if (name === KEY_NAME && rrtype === "TXT") {
        return txtStrings(record).map((part) => [part]);
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
