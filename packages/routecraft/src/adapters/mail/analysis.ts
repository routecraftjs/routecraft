/**
 * Sender analysis for received mail messages.
 *
 * Derives the "effective sender" by unwinding mailing-list and auto-forward
 * rewrites using already-present headers (`List-Id`, `X-Original-From`,
 * `Authentication-Results`, `ARC-*`). No network, no crypto. For cryptographic
 * verification see `strict-verify.ts`.
 *
 * @experimental
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How a message reached the recipient. */
export type ForwardType = "direct" | "auto-forward" | "mailing-list";

/** Trust state of the effective sender. */
export type TrustLevel = "verified" | "unverified" | "failed";

/** Parsed email address. */
export interface EmailAddress {
  address: string;
  name?: string;
  domain: string;
}

/** One hop in a forward chain. */
export interface ForwardHop {
  via: EmailAddress;
  type: "auto-forward" | "mailing-list";
  arcInstance?: number;
}

/** Effective sender plus the evidence used to resolve it. */
export interface MailSender extends EmailAddress {
  /** How the message reached us. */
  forwardType: ForwardType;
  /** Chain of forwarders, nearest hop first. Empty for direct mail. */
  forwardChain: ForwardHop[];
  /** Trust state of this sender. */
  trust: TrustLevel;
  /** Machine-readable reason, e.g. "list-forward-arc-verified". */
  reason: string;
  /** Authentication verdicts from the receiving server's Authentication-Results. */
  authentication: {
    dkim: "pass" | "fail" | "neutral" | "none";
    spf: "pass" | "fail" | "neutral" | "none";
    dmarc: "pass" | "fail" | "neutral" | "none";
    arc: "pass" | "fail" | "none";
  };
  /** Literal `From:` header, only set when it differs from the effective sender. */
  headerFrom?: EmailAddress;
}

// ---------------------------------------------------------------------------
// Header allowlist used for analysis
// ---------------------------------------------------------------------------

/**
 * Lowercased header names relevant to sender analysis. Always extracted from
 * a parsed message even when the caller has not requested `includeHeaders`.
 */
export const ANALYSIS_HEADER_NAMES = [
  "from",
  "sender",
  "reply-to",
  "x-original-from",
  "x-original-sender",
  "list-id",
  "list-post",
  "list-unsubscribe",
  "precedence",
  "authentication-results",
  "arc-authentication-results",
  "arc-message-signature",
  "arc-seal",
  "received",
] as const;

/**
 * Extract the auth-relevant headers from a mailparser `headerLines` array.
 * Keys are lowercased. Multi-value headers become arrays.
 */
export function extractAnalysisHeaders(
  headerLines: ReadonlyArray<{ key: string; line: string }> | undefined,
): Record<string, string | string[]> {
  if (!headerLines) return {};
  const wanted = new Set<string>(ANALYSIS_HEADER_NAMES);
  const out: Record<string, string | string[]> = {};
  for (const entry of headerLines) {
    const key = entry.key.toLowerCase();
    if (!wanted.has(key)) continue;
    const colonIdx = entry.line.indexOf(":");
    const value =
      colonIdx >= 0 ? entry.line.slice(colonIdx + 1).trim() : entry.line;
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single address header value like `"Team Flextender" <x@y.nl>` or `x@y.nl`.
 * Returns null when no address-looking token is found.
 */
export function parseAddress(value: string | undefined): EmailAddress | null {
  if (!value) return null;
  const trimmed = value.trim();
  // "Name" <addr@host> or Name <addr@host>
  const angle = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
  let addr: string;
  let name: string | undefined;
  if (angle) {
    name = angle[1].trim().replace(/^"|"$/g, "").trim() || undefined;
    addr = angle[2].trim();
  } else {
    addr = trimmed;
  }
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  const result: EmailAddress = {
    address: addr.toLowerCase(),
    domain,
  };
  if (name) result.name = name;
  return result;
}

/** Pick the first value of a possibly-multi-value header. */
function firstHeader(
  headers: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** All values of a possibly-multi-value header. */
function allHeaders(
  headers: Record<string, string | string[]>,
  key: string,
): string[] {
  const v = headers[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Authentication-Results parsing
// ---------------------------------------------------------------------------

type AuthVerdict = "pass" | "fail" | "neutral" | "none";

interface ParsedAuthResults {
  dkim: AuthVerdict;
  spf: AuthVerdict;
  dmarc: AuthVerdict;
  /** header.from reported by dmarc, if present. */
  dmarcHeaderFrom?: string;
  /** header.i (or header.d) reported by the strongest dkim result. */
  dkimDomain?: string;
}

/**
 * Parse an `Authentication-Results` style header value.
 *
 * Format (RFC 8601): `authserv-id; method=result (comment) property=value; ...`
 * We pluck out method verdicts plus a couple of properties we care about.
 */
export function parseAuthResults(value: string | undefined): ParsedAuthResults {
  const out: ParsedAuthResults = {
    dkim: "none",
    spf: "none",
    dmarc: "none",
  };
  if (!value) return out;
  // Each result is separated by `;`. The first token is the authserv-id.
  const parts = value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const methodMatch = part.match(/^(dkim|spf|dmarc)\s*=\s*(\w+)/i);
    if (!methodMatch) continue;
    const method = methodMatch[1].toLowerCase() as "dkim" | "spf" | "dmarc";
    const verdict = methodMatch[2].toLowerCase();
    const normalized: AuthVerdict =
      verdict === "pass" || verdict === "fail" || verdict === "neutral"
        ? verdict
        : "none";
    // Prefer the first non-none verdict we see per method (closest to authserv).
    if (out[method] === "none") out[method] = normalized;

    if (method === "dmarc") {
      const hf = part.match(/header\.from\s*=\s*([^\s;]+)/i);
      if (hf && !out.dmarcHeaderFrom) out.dmarcHeaderFrom = hf[1].toLowerCase();
    }
    if (method === "dkim") {
      const di =
        part.match(/header\.i\s*=\s*@?([^\s;]+)/i) ??
        part.match(/header\.d\s*=\s*([^\s;]+)/i);
      if (di && !out.dkimDomain) out.dkimDomain = di[1].toLowerCase();
    }
  }
  return out;
}

/**
 * Parse an `ARC-Authentication-Results` header; same body format as
 * `Authentication-Results`, prefixed with `i=N;`.
 */
function parseArcAuthResults(
  value: string,
): { instance: number; results: ParsedAuthResults } | null {
  const m = value.match(/^\s*i\s*=\s*(\d+)\s*;\s*(.*)$/s);
  if (!m) return null;
  const instance = Number(m[1]);
  if (!Number.isFinite(instance)) return null;
  return { instance, results: parseAuthResults(m[2]) };
}

interface ArcChainState {
  /** Final chain validity from the highest-instance ARC-Seal's `cv=`. */
  cv: "pass" | "fail" | "none";
  /** ARC signer domain per instance, parsed from ARC-Seal `d=`. */
  domainsByInstance: Map<number, string>;
}

/** Read ARC chain state from every `ARC-Seal` header. */
function parseArcChainState(
  headers: Record<string, string | string[]>,
): ArcChainState {
  const out: ArcChainState = { cv: "none", domainsByInstance: new Map() };
  const seals = allHeaders(headers, "arc-seal");
  if (seals.length === 0) return out;
  let bestInstance = -1;
  for (const seal of seals) {
    const i = seal.match(/\bi\s*=\s*(\d+)/);
    if (!i) continue;
    const instance = Number(i[1]);
    const d = seal.match(/\bd\s*=\s*([^\s;]+)/i);
    if (d) out.domainsByInstance.set(instance, d[1].toLowerCase());
    const cv = seal.match(/\bcv\s*=\s*(\w+)/i);
    if (cv && instance > bestInstance) {
      bestInstance = instance;
      const v = cv[1].toLowerCase();
      out.cv = v === "pass" ? "pass" : v === "fail" ? "fail" : "none";
    }
  }
  return out;
}

/**
 * Build a placeholder {@link EmailAddress} when only the sending domain is
 * known (e.g. from ARC `d=` or DMARC `header.from=<domain>`). The synthesised
 * local part is a stable marker so equality checks against real addresses
 * never collide.
 */
function addressFromDomain(domain: string, marker: string): EmailAddress {
  return { address: `${marker}@${domain}`, domain };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Derive a {@link MailSender} from the auth-relevant headers of a received
 * message. Pure function, no I/O.
 *
 * @param headers - Lowercased header map, as returned by {@link extractAnalysisHeaders}.
 */
export function analyzeHeaders(
  headers: Record<string, string | string[]>,
): MailSender {
  const headerFrom = parseAddress(firstHeader(headers, "from"));
  const listId = firstHeader(headers, "list-id");
  const precedence = firstHeader(headers, "precedence");
  const sender = parseAddress(firstHeader(headers, "sender"));
  const xOriginalFrom = parseAddress(firstHeader(headers, "x-original-from"));
  const xOriginalSender = parseAddress(
    firstHeader(headers, "x-original-sender"),
  );

  const authResults = parseAuthResults(
    firstHeader(headers, "authentication-results"),
  );
  const arcResults = allHeaders(headers, "arc-authentication-results")
    .map(parseArcAuthResults)
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.instance - b.instance);
  const arcChain = parseArcChainState(headers);

  const isList =
    listId !== undefined ||
    /^\s*(list|bulk)\b/i.test(precedence ?? "") ||
    (sender !== null &&
      headerFrom !== null &&
      sender.domain !== headerFrom.domain);
  const hasArc = arcResults.length > 0 || arcChain.cv !== "none";

  let forwardType: ForwardType = "direct";
  let effective: EmailAddress | null = headerFrom;
  const forwardChain: ForwardHop[] = [];
  let reason = "direct";

  if (isList) {
    forwardType = "mailing-list";
    // Prefer explicit X-Original-From (Google Groups), then X-Original-Sender,
    // then an authenticated domain from the earliest ARC instance (synthesised
    // because `header.from=` is domain-only), else Sender.
    const arcFirst = arcResults[0];
    const arcFromDomain = arcFirst?.results.dmarcHeaderFrom;
    const arcFrom: EmailAddress | null =
      arcFromDomain && (!headerFrom || headerFrom.domain !== arcFromDomain)
        ? addressFromDomain(arcFromDomain, "unknown")
        : null;
    effective =
      xOriginalFrom ?? xOriginalSender ?? arcFrom ?? sender ?? headerFrom;
    const via = headerFrom ?? sender;
    if (via) {
      const hop: ForwardHop = { via, type: "mailing-list" };
      if (arcFirst) hop.arcInstance = arcFirst.instance;
      forwardChain.push(hop);
    }
    reason =
      arcChain.cv === "pass"
        ? "list-forward-arc-verified"
        : hasArc
          ? "list-forward-arc-unverified"
          : "list-forward-unverified";
  } else if (hasArc) {
    forwardType = "auto-forward";
    effective = headerFrom;
    // One hop per ARC instance, nearest (highest i=) first. Prefer the ARC
    // signer domain from ARC-Seal `d=`; fall back to the instance's
    // authentication-results header.from domain.
    const instances =
      arcResults.length > 0
        ? arcResults.map((r) => r.instance)
        : [...arcChain.domainsByInstance.keys()];
    for (const instance of [...instances].sort((a, b) => b - a)) {
      const arcDomain =
        arcChain.domainsByInstance.get(instance) ??
        arcResults.find((r) => r.instance === instance)?.results
          .dmarcHeaderFrom;
      const hop: ForwardHop = {
        via: arcDomain
          ? addressFromDomain(arcDomain, "arc")
          : { address: "", domain: "" },
        type: "auto-forward",
        arcInstance: instance,
      };
      forwardChain.push(hop);
    }
    reason =
      arcChain.cv === "pass"
        ? "auto-forward-arc-verified"
        : "auto-forward-arc-unverified";
  } else {
    forwardType = "direct";
    effective = headerFrom;
    reason =
      authResults.dmarc === "pass"
        ? "direct-dmarc-aligned"
        : authResults.dmarc === "fail"
          ? "direct-dmarc-fail"
          : "direct-unverified";
  }

  // Trust:
  //   - failed: any explicit dmarc=fail for a non-forwarded message, or ARC cv=fail
  //   - verified: direct + dmarc=pass, or forwarded + arc cv=pass
  //   - unverified: everything else
  let trust: TrustLevel;
  if (forwardType === "direct") {
    trust =
      authResults.dmarc === "pass"
        ? "verified"
        : authResults.dmarc === "fail"
          ? "failed"
          : "unverified";
  } else {
    trust =
      arcChain.cv === "pass"
        ? "verified"
        : arcChain.cv === "fail"
          ? "failed"
          : "unverified";
  }

  const fallbackAddress = effective ?? headerFrom ?? sender;
  const resolvedAddress: EmailAddress = fallbackAddress ?? {
    address: "",
    domain: "",
  };

  const result: MailSender = {
    address: resolvedAddress.address,
    domain: resolvedAddress.domain,
    forwardType,
    forwardChain,
    trust,
    reason,
    authentication: {
      dkim: authResults.dkim,
      spf: authResults.spf,
      dmarc: authResults.dmarc,
      arc: arcChain.cv,
    },
  };
  if (resolvedAddress.name) result.name = resolvedAddress.name;
  if (headerFrom && headerFrom.address !== resolvedAddress.address) {
    result.headerFrom = headerFrom;
  }
  return result;
}
