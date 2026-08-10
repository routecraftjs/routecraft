import { rcError } from "@routecraft/routecraft";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/**
 * Address-level egress guard for the built-in web tools.
 *
 * ## What this protects against
 *
 * A model that picks its own URL can try to reach infrastructure the
 * deployer never meant to expose: the loopback interface, RFC 1918
 * ranges, and the cloud metadata endpoint at `169.254.169.254`, which on
 * an unhardened instance hands out credentials to anything that asks.
 * Every hostname is resolved, and every address it resolves to is
 * classified, before a connection is attempted. Only public unicast
 * addresses pass.
 *
 * ## What this does NOT protect against
 *
 * These are real gaps, listed so a deployer can close them at the layer
 * that can actually close them rather than assuming this function did.
 *
 * - **DNS rebinding.** This guard resolves the hostname, then hands the
 *   URL to `fetch`, which resolves it again independently. A resolver
 *   that answers the first query with a public address and the second
 *   with a private one defeats the check. Pinning the vetted address
 *   into the connection needs a runtime hook (undici's `connect.lookup`)
 *   with no equivalent under Bun, so it is deliberately not attempted
 *   rather than half-built. Close it with an egress proxy or a network
 *   policy that enforces the same rule at the packet level.
 * - **Private services on public addresses.** A host the deployer
 *   considers internal but which resolves to a public address is
 *   indistinguishable here from any other public host. Use
 *   `allowedDomains` to bound reachable hosts by name, and network-level
 *   egress control for the general case.
 * - **Content.** Nothing here inspects what comes back. A public page
 *   can still carry prompt injection aimed at the calling model.
 */

/** Schemes a built-in web tool will dereference. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The one `ipaddr.js` range that is publicly routable. Every other range
 * the library reports (`loopback`, `private`, `linkLocal`, `uniqueLocal`,
 * `carrierGradeNat`, `reserved`, `multicast`, `broadcast`, `unspecified`,
 * and the IPv6 transition ranges `6to4`, `teredo`, `rfc6052`, `rfc6145`)
 * is refused.
 *
 * Allowlisting the single good range rather than denylisting the bad ones
 * means a range added by a future `ipaddr.js` version fails closed.
 */
const PUBLIC_RANGE = "unicast";

/**
 * Classify one already-parsed address. IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * is unwrapped first: the mapped form reports its own range rather than
 * the range of the address it carries, so `::ffff:127.0.0.1` would
 * otherwise be judged on the wrapper instead of on the loopback address
 * inside it.
 */
function isPublicAddress(parsed: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return v6.toIPv4Address().range() === PUBLIC_RANGE;
    }
    // RFC 4291 deprecated the IPv4-compatible form (::a.b.c.d). ipaddr.js
    // has no range for ::/96, so ::7f00:1 would otherwise be judged on
    // the empty wrapper and pass as unicast. IANA reserves the whole
    // block, so refusing it outright loses nothing.
    if (v6.parts.slice(0, 6).every((part) => part === 0)) return false;
  }
  return parsed.range() === PUBLIC_RANGE;
}

/**
 * Resolve `hostname` to every address a connection could land on.
 *
 * `all: true` matters: checking only the first answer would let a host
 * with one public and one private address through, because `fetch` is
 * free to pick either.
 */
async function resolveAll(hostname: string): Promise<string[]> {
  // An IP literal in the URL never reaches the resolver, so classify it
  // directly. `URL` keeps IPv6 literals in brackets, which ipaddr.js does
  // not accept.
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (ipaddr.isValid(literal)) return [literal];

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  } catch (cause) {
    // AI3002, not AI3001: a resolver rejection is an environmental
    // failure and is usually transient, so it must stay retryable. AI3001
    // is reserved for refusals we decided on, which retrying cannot fix.
    throw rcError("AI3002", cause, {
      message: `WebFetch: could not resolve host "${hostname}".`,
    });
  }
}

/**
 * Reject `url` unless it is safe to dereference: an http(s) URL whose
 * host resolves exclusively to public unicast addresses, and (when
 * `allowedDomains` is non-empty) whose host is on that list.
 *
 * Throws `AI3001` on every refusal. The thrown error reaches the calling
 * model as a tool error, so the message names the host and the reason
 * without echoing anything the host returned.
 *
 * @param url - Already-parsed target URL.
 * @param allowedDomains - Host allowlist. Empty means "any public host".
 *   An entry matches its exact host and any subdomain of it.
 */
export async function assertFetchableUrl(
  url: URL,
  allowedDomains: readonly string[],
): Promise<void> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw rcError("AI3001", undefined, {
      message:
        `WebFetch: refusing to fetch "${url.protocol}" URL. ` +
        `Only http: and https: are supported.`,
    });
  }

  if (url.username !== "" || url.password !== "") {
    throw rcError("AI3001", undefined, {
      message:
        `WebFetch: refusing a URL carrying embedded credentials. ` +
        `Strip the "user:password@" prefix.`,
    });
  }

  if (allowedDomains.length > 0 && !matchesAllowedDomain(url, allowedDomains)) {
    throw rcError("AI3001", undefined, {
      message:
        `WebFetch: host "${url.hostname}" is not in the configured allowedDomains ` +
        `(${allowedDomains.join(", ")}).`,
    });
  }

  const addresses = await resolveAll(url.hostname);
  if (addresses.length === 0) {
    throw rcError("AI3002", undefined, {
      message: `WebFetch: host "${url.hostname}" resolved to no addresses.`,
    });
  }

  for (const address of addresses) {
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.parse(address);
    } catch (cause) {
      // An address the resolver returned but ipaddr.js cannot parse is
      // unclassifiable, so it fails closed rather than being skipped.
      throw rcError("AI3001", cause, {
        message: `WebFetch: host "${url.hostname}" resolved to an unparseable address "${address}".`,
      });
    }
    if (!isPublicAddress(parsed)) {
      throw rcError("AI3001", undefined, {
        message:
          `WebFetch: refusing to fetch "${url.hostname}": it resolves to the ` +
          `non-public address ${address}. Private, loopback, link-local, and ` +
          `cloud-metadata ranges are not reachable from this tool.`,
      });
    }
  }
}

/**
 * True when `url`'s host equals an allowlist entry or is a subdomain of
 * one. The dot boundary is what keeps `evil-example.com` from matching an
 * entry of `example.com`.
 *
 * Entries arrive normalised from the factory (lowercased, punycode), so
 * this only has to strip the optional root-zone dot a host may carry and
 * compare.
 */
function matchesAllowedDomain(
  url: URL,
  allowedDomains: readonly string[],
): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
