import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as realDnsPromises } from "node:dns";
// The AI* codes register as a side effect of this module. Production
// callers get it through the package index; a test that imports the leaf
// module directly has to ask for it.
import "../src/errors.ts";

/**
 * Egress-guard tests for the built-in `WebFetch` tool.
 *
 * The resolver is mocked so hostname cases can be exercised without a
 * network, and restored in `afterAll` from `node:dns`'s own `promises`
 * export. `mock.module` is process-global in bun 1.3.11, and
 * `node:dns/promises` is mocked by no other file in the suite; the
 * restore keeps it that way if one is added later.
 */
const lookupMock = mock();
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

afterAll(() => {
  mock.module("node:dns/promises", () => realDnsPromises);
});

const { assertFetchableUrl } =
  await import("../src/agent/tools/web-fetch/ssrf.ts");

/** Address records in the shape `dns.lookup(host, { all: true })` returns. */
function records(...addresses: string[]) {
  return addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
}

/** Run the guard and hand back whatever it threw, without asserting a code. */
async function capture(url: string, allowed: string[] = []): Promise<unknown> {
  return assertFetchableUrl(new URL(url), allowed).then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function expectRejected(url: string, allowed: string[] = []) {
  const error = await capture(url, allowed);
  expect(error).toMatchObject({ rc: "AI2001" });
  return error as Error;
}

describe("WebFetch egress guard", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  /**
   * @case A non-http(s) scheme is refused before anything is dereferenced
   * @preconditions A file: URL, no allowlist configured
   * @expectedResult Rejects with AI2001 naming the scheme; the resolver is never consulted
   */
  test("refuses non-http(s) schemes", async () => {
    const error = await expectRejected("file:///etc/passwd");
    expect(error.message).toMatch(/only http: and https:/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  /**
   * @case A URL carrying embedded credentials is refused
   * @preconditions https URL with a "user:password@" prefix
   * @expectedResult Rejects with AI2001 telling the caller to strip the prefix
   */
  test("refuses URLs with embedded credentials", async () => {
    const error = await expectRejected("https://user:secret@example.com/");
    expect(error.message).toMatch(/embedded credentials/i);
  });

  /**
   * @case Loopback reached by IP literal is refused without a DNS round trip
   * @preconditions http://127.0.0.1/ , an address ipaddr.js classifies as loopback
   * @expectedResult Rejects with AI2001; the resolver is never consulted
   */
  test("refuses the IPv4 loopback address", async () => {
    const error = await expectRejected("http://127.0.0.1/");
    expect(error.message).toMatch(/non-public address/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  /**
   * @case The cloud metadata endpoint is refused
   * @preconditions http://169.254.169.254/latest/meta-data/, the link-local address that serves instance credentials
   * @expectedResult Rejects with AI2001
   */
  test("refuses the cloud metadata address", async () => {
    await expectRejected("http://169.254.169.254/latest/meta-data/");
  });

  /**
   * @case RFC 1918 space is refused
   * @preconditions http://10.0.0.5/ , a private-range literal
   * @expectedResult Rejects with AI2001
   */
  test("refuses private-range addresses", async () => {
    await expectRejected("http://10.0.0.5/");
  });

  /**
   * @case IPv6 loopback in bracket form is refused
   * @preconditions http://[::1]/ , which URL keeps bracketed in `hostname`
   * @expectedResult Rejects with AI2001 rather than failing to parse the address
   */
  test("refuses the IPv6 loopback address", async () => {
    await expectRejected("http://[::1]/");
  });

  /**
   * @case An IPv4-mapped IPv6 address is judged on the address it carries
   * @preconditions http://[::ffff:127.0.0.1]/ , whose own range is ipv4Mapped rather than loopback
   * @expectedResult Rejects with AI2001, proving the mapped form is unwrapped before classification
   */
  test("unwraps IPv4-mapped IPv6 before classifying", async () => {
    await expectRejected("http://[::ffff:127.0.0.1]/");
  });

  /**
   * @case The deprecated IPv4-compatible IPv6 form does not slip past the range allowlist
   * @preconditions http://[::7f00:1]/ (::127.0.0.1) and http://[::a9fe:a9fe]/ (::169.254.169.254), both of which ipaddr.js classifies as unicast rather than loopback or link-local
   * @expectedResult Both reject with AI2001, proving ::/96 is refused rather than judged on its empty wrapper
   */
  test("refuses IPv4-compatible IPv6 addresses", async () => {
    await expectRejected("http://[::7f00:1]/");
    await expectRejected("http://[::a9fe:a9fe]/");
  });

  /**
   * @case A public IP literal passes
   * @preconditions http://93.184.216.34/ , a public unicast address
   * @expectedResult Resolves without throwing; the resolver is never consulted
   */
  test("accepts a public IP literal", async () => {
    await assertFetchableUrl(new URL("http://93.184.216.34/"), []);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  /**
   * @case A hostname resolving into private space is refused
   * @preconditions Resolver returns 192.168.1.10 for the host
   * @expectedResult Rejects with AI2001 naming the resolved address
   */
  test("refuses a hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue(records("192.168.1.10"));
    const error = await expectRejected("https://internal.example.com/");
    expect(error.message).toMatch(/192\.168\.1\.10/);
  });

  /**
   * @case Every resolved address is checked, not just the first
   * @preconditions Resolver returns a public address followed by a loopback one
   * @expectedResult Rejects with AI2001, since fetch could have connected to either
   */
  test("refuses when any resolved address is non-public", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34", "127.0.0.1"));
    const error = await expectRejected("https://rebind.example.com/");
    expect(error.message).toMatch(/127\.0\.0\.1/);
  });

  /**
   * @case A hostname resolving to public space passes
   * @preconditions Resolver returns a single public address
   * @expectedResult Resolves without throwing
   */
  test("accepts a hostname that resolves to a public address", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34"));
    await assertFetchableUrl(new URL("https://example.com/"), []);
  });

  /**
   * @case A host absent from a configured allowlist is refused
   * @preconditions allowedDomains is ["example.com"], target host is other.com
   * @expectedResult Rejects with AI2001 listing the configured domains, before any DNS work
   */
  test("refuses a host outside allowedDomains", async () => {
    const error = await expectRejected("https://other.com/", ["example.com"]);
    expect(error.message).toMatch(/allowedDomains/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  /**
   * @case A subdomain of an allowlist entry is permitted
   * @preconditions allowedDomains is ["example.com"], target host is docs.example.com resolving publicly
   * @expectedResult Resolves without throwing
   */
  test("accepts a subdomain of an allowlist entry", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34"));
    await assertFetchableUrl(new URL("https://docs.example.com/"), [
      "example.com",
    ]);
  });

  /**
   * @case A lookalike host does not match an allowlist entry by suffix
   * @preconditions allowedDomains is ["example.com"], target host is evil-example.com
   * @expectedResult Rejects with AI2001, proving the match requires a dot boundary
   */
  test("refuses a lookalike host that merely ends with an entry", async () => {
    await expectRejected("https://evil-example.com/", ["example.com"]);
  });

  /**
   * @case A resolver failure is classified as transient rather than as a refusal
   * @preconditions Resolver rejects with ENOTFOUND
   * @expectedResult Rejects with the retryable AI2002 rather than the permanent AI2001, so a brief DNS outage is not treated as a policy decision
   */
  test("reports a resolver failure as retryable", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const error = await capture("https://nope.example.com/");
    expect(error).toMatchObject({ rc: "AI2002", retryable: true });
    expect((error as Error).message).toMatch(/could not resolve host/i);
  });

  /**
   * @case A host resolving to nothing does not fall through to a fetch
   * @preconditions Resolver returns an empty record set
   * @expectedResult Rejects with AI2002, the same transient class as a resolver rejection
   */
  test("refuses a host that resolves to no addresses", async () => {
    lookupMock.mockResolvedValue([]);
    const error = await capture("https://empty.example.com/");
    expect(error).toMatchObject({ rc: "AI2002" });
    expect((error as Error).message).toMatch(/no addresses/i);
  });

  /**
   * @case A host carrying the root-zone trailing dot still matches its allowlist entry
   * @preconditions allowedDomains is ["example.com"], target host is written as example.com. with a trailing dot
   * @expectedResult Resolves without throwing, rather than failing closed on a cosmetic difference
   */
  test("matches a host written with a trailing dot", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34"));
    await assertFetchableUrl(new URL("https://example.com./"), ["example.com"]);
  });

  /**
   * @case An internationalised host matches an allowlist entry stored in punycode
   * @preconditions Entry is the punycoded xn--exmple-cua.com, target host is the Unicode exämple.com which URL punycodes
   * @expectedResult Resolves without throwing, proving both sides meet in the same encoding
   */
  test("matches an internationalised host against its punycode entry", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34"));
    await assertFetchableUrl(new URL("https://exämple.com/"), [
      "xn--exmple-cua.com",
    ]);
  });
});
