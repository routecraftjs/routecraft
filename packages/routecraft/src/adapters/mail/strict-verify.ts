/**
 * Cryptographic verification of a received message via `mailauth`.
 *
 * Only loaded when the mail adapter is configured with `verify: "strict"`.
 * `mailauth` is an optional peer; users who enable strict mode must install it.
 */

import { promises as dns } from "node:dns";
import { rcError } from "../../error.ts";
import { loadOptionalPeer } from "../shared/optional-peer.ts";
import { isBun } from "../../shared/runtime-env.ts";
import type { MailSender } from "./analysis.ts";

/**
 * Cached `mailauth.authenticate` so a missing install is surfaced (and a
 * successful install resolved) exactly once per process.
 */
let authenticatePromise:
  | Promise<
      (
        input: Buffer | string,
        options?: Record<string, unknown>,
      ) => Promise<MailAuthResult>
    >
  | undefined;

/**
 * Run `mailauth.authenticate()` on the raw message source and fold the
 * cryptographic verdicts back into the header-derived {@link MailSender}.
 *
 * The header-derived analysis already resolved the forward chain and effective
 * sender; this pass only overrides the `authentication` verdicts and `trust`
 * based on cryptographic checks (DKIM/SPF/DMARC/ARC).
 */
export async function verifyStrict(
  source: Buffer | undefined,
  sender: MailSender,
): Promise<MailSender> {
  if (!source) return sender;

  if (!authenticatePromise) {
    authenticatePromise = (async () => {
      const mod = (await loadOptionalPeer(() => import("mailauth"), {
        consumer: "mail adapter (verify: 'strict')",
        packageName: "mailauth",
      })) as unknown as {
        authenticate: (
          input: Buffer | string,
          options?: Record<string, unknown>,
        ) => Promise<MailAuthResult>;
      };
      return mod.authenticate;
    })();
  }
  const authenticate = await authenticatePromise;

  let result: MailAuthResult;
  try {
    result = await authenticate(source, {
      trustReceived: false,
      resolver: resolveForMailauth,
    });
  } catch (error) {
    throw rcError("RC5001", error instanceof Error ? error : undefined, {
      message: `mailauth verification failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const dkim = normalizeVerdict(result.dkim?.results?.[0]?.status?.result);
  const spf = normalizeVerdict(result.spf?.status?.result);
  const dmarc = normalizeVerdict(result.dmarc?.status?.result);
  const arc = normalizeArc(result.arc?.status?.result);

  const updated: MailSender = {
    ...sender,
    authentication: { dkim, spf, dmarc, arc },
  };

  if (sender.forwardType === "direct") {
    updated.trust =
      dmarc === "pass"
        ? "verified"
        : dmarc === "fail"
          ? "failed"
          : "unverified";
    updated.reason =
      dmarc === "pass"
        ? "direct-dmarc-crypto-verified"
        : dmarc === "fail"
          ? "direct-dmarc-crypto-fail"
          : "direct-crypto-unverified";
  } else {
    updated.trust =
      arc === "pass" ? "verified" : arc === "fail" ? "failed" : "unverified";
    updated.reason = `${sender.forwardType}-arc-crypto-${
      arc === "pass" ? "verified" : arc === "fail" ? "fail" : "unverified"
    }`;
  }

  return updated;
}

/**
 * Put a DKIM, ARC or DMARC record back together when the runtime split it.
 *
 * A TXT string holds at most 255 bytes, so every real key is published as
 * several strings of one record. Node returns them as one record; Bun returns
 * each string as a record of its own, and `mailauth` reads only the first, so
 * the key arrives truncated and every signature fails as an invalid key.
 *
 * The split shape is recognised, not assumed from the runtime alone: every
 * record holds exactly one string. A string that opens with a `v=` tag starts
 * a record and the strings after it continue that record, so two records
 * published at one name (a key being rotated) stay two, as they are on Node.
 *
 * The join is scoped to `_domainkey` and `_dmarc` names, whose records open
 * with a version tag. Any other name keeps its records apart: an apex
 * publishes SPF beside unrelated TXT records that carry no such tag, and
 * joining those would corrupt the SPF policy.
 *
 * @param name - The name that was looked up
 * @param rrtype - The record type that was asked for
 * @param records - What the runtime's resolver returned
 * @param splitsStrings - Whether this runtime returns each string as its own record
 * @returns The records, with a split record made whole
 */
export function rejoinKeyRecord(
  name: string,
  rrtype: string,
  records: string[][] | string[],
  splitsStrings: boolean,
): string[][] | string[] {
  if (!splitsStrings || rrtype !== "TXT" || records.length < 2) return records;
  const labels = name.toLowerCase().split(".");
  if (!labels.includes("_domainkey") && labels[0] !== "_dmarc") return records;
  const strings: string[] = [];
  for (const record of records) {
    if (!Array.isArray(record) || record.length !== 1) return records;
    strings.push(record[0] as string);
  }
  const rejoined: string[][] = [];
  for (const value of strings) {
    const open = rejoined.at(-1);
    if (open === undefined || /^\s*v\s*=/i.test(value)) rejoined.push([value]);
    else open.push(value);
  }
  return rejoined;
}

/** The resolver `mailauth` is handed: the runtime's own, with {@link rejoinKeyRecord} applied. */
async function resolveForMailauth(
  name: string,
  rrtype: string,
): Promise<string[][] | string[]> {
  const records = (await dns.resolve(name, rrtype)) as string[][] | string[];
  return rejoinKeyRecord(name, rrtype, records, isBun());
}

// ---------------------------------------------------------------------------
// Internal typing for mailauth's result shape (partial, just what we use)
// ---------------------------------------------------------------------------

interface MailAuthStatus {
  result?: string;
}

interface MailAuthResult {
  dkim?: { results?: Array<{ status?: MailAuthStatus }> };
  spf?: { status?: MailAuthStatus };
  dmarc?: { status?: MailAuthStatus };
  arc?: { status?: MailAuthStatus };
}

function normalizeVerdict(
  v: string | undefined,
): "pass" | "fail" | "neutral" | "none" {
  const n = (v ?? "").toLowerCase();
  return n === "pass" || n === "fail" || n === "neutral" ? n : "none";
}

function normalizeArc(v: string | undefined): "pass" | "fail" | "none" {
  const n = (v ?? "").toLowerCase();
  return n === "pass" || n === "fail" ? n : "none";
}
