/**
 * Cryptographic verification of a received message via `mailauth`.
 *
 * Only loaded when the mail adapter is configured with `verify: "strict"`.
 * `mailauth` is an optional peer; users who enable strict mode must install it.
 */

import { rcError } from "../../error.ts";
import { loadOptionalPeer } from "../shared/optional-peer.ts";
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
        adapterName: "mail (verify: 'strict')",
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
    result = await authenticate(source, { trustReceived: false });
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
