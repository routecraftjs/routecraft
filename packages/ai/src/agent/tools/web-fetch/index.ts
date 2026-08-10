import { rcError, type KnownTag } from "@routecraft/routecraft";
import type { FnHandlerContext, FnOptions } from "../../../fn/types.ts";
import { toMarkdown } from "./convert.ts";
import { extractArticle } from "./extract.ts";
import {
  fetchResource,
  type FetchBounds,
  type FetchedResource,
} from "./fetch.ts";
import { webFetchInputSchema, type WebFetchInput } from "./schema.ts";

/**
 * Bytes read off the wire before the response is cut short.
 *
 * This bounds CPU, not just memory. Extraction and markdown conversion
 * are synchronous and run on the same event loop as every route,
 * consumer, and timer in the process, and turndown's cost is superlinear
 * in the number of block elements. Measured against the shipped peers on
 * block-heavy HTML: 250 KB converts in ~0.4s, 500 KB in ~1.7s, and 1 MB
 * in ~12s. The default sits below that knee so one tool call cannot stall
 * the process for seconds. Raising it trades the whole loop for reach.
 */
const DEFAULT_MAX_BYTES = 500_000;
/**
 * Hard ceiling on the HTML handed to extraction, independent of
 * `maxBytes`.
 *
 * `maxBytes` is a deployer's dial and can be raised; this is the backstop
 * that keeps the CPU bound from being configured away by accident. Above
 * it the fetch fails with `AI2003` rather than blocking the loop.
 */
const MAX_EXTRACTABLE_CHARS = 600_000;
/** Markdown characters returned in one response. */
const DEFAULT_MAX_LENGTH = 50_000;
/** Deadline for the whole fetch, redirects included. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Same-host redirect hops followed before giving up. */
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Media types returned verbatim, with no extraction or conversion.
 *
 * The empty string is deliberate: it is what a response with no
 * `Content-Type` produces, and the realistic source of that is a server
 * handing back an extensionless plain-text file, for which passing the
 * body through is the right answer. The cost is that a header-less HTML
 * page reaches the model as raw markup rather than extracted prose.
 */
const TEXT_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "",
]);
/** Media types run through extraction and markdown conversion. */
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Everything this tool can render, handed to the fetch step so an
 * unsupported type is refused on its headers rather than downloaded in
 * full and then thrown away.
 */
const ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  ...TEXT_TYPES,
  ...HTML_TYPES,
]);

/** Registration-time configuration for {@link webFetch}. */
export interface WebFetchOptions {
  /**
   * Hosts this tool may read. An entry matches its exact host and any
   * subdomain of it. Empty or omitted means any public host, which is
   * the drop-in-compatible default but the weaker posture: set it when
   * the agent's job only needs a known set of sites.
   */
  allowedDomains?: string[];
  /**
   * Bytes read off the wire per fetch. Defaults to 500,000.
   *
   * Bounds extraction CPU as well as memory, so raising it lengthens the
   * synchronous stall a single large page imposes on the whole process.
   */
  maxBytes?: number;
  /** Markdown characters per response. Defaults to 50,000. */
  maxLength?: number;
  /** Deadline in milliseconds for a whole fetch. Defaults to 30,000. */
  timeoutMs?: number;
  /** Same-host redirect hops followed. Defaults to 5. */
  maxRedirects?: number;
}

/** What the model receives back from a `WebFetch` call. */
export interface WebFetchResult {
  /** URL actually read, or the URL that issued an un-followed redirect. */
  url: string;
  /** Page title, when the document supplied one. */
  title?: string;
  /**
   * Page content as markdown. When {@link truncated} is true this string
   * ends with a visible truncation notice naming the full length and the
   * offset to resume from, so a model can tell a clipped page from a
   * short one without reading the sibling fields.
   */
  content: string;
  /** True when {@link content} is a slice of a longer document. */
  truncated: boolean;
  /**
   * Length in characters of the full markdown. When the response itself
   * hit the byte cap this is a lower bound, and the truncation notice
   * says so.
   *
   * Zero on a cross-host redirect, where no document was read at all.
   * {@link content} still carries the notice naming the target, so read
   * {@link redirectedTo} rather than treating zero as an empty page.
   */
  totalLength: number;
  /** Offset to pass back to continue reading. Set only when truncated. */
  nextOffset?: number;
  /**
   * Target of a cross-host redirect that was deliberately not followed.
   * When set, no content was read from it.
   */
  redirectedTo?: string;
}

/**
 * Built-in fn factory: read a URL and return its content as markdown.
 *
 * Assign it a tool name in `agentPlugin({ functions: { ... } })`, the
 * same way as `currentTime()` or `directTool(...)`. It is deliberately
 * NOT part of any default set: it performs network egress on a URL the
 * model chooses, so registering it must be a decision someone made.
 *
 * ## What the tool does
 *
 * A credential-free GET, then extraction of the readable region, then
 * markdown conversion. Output is bounded: long pages come back truncated
 * with a visible notice and an `offset` to resume from, never silently
 * clipped and never summarised away.
 *
 * ## What it protects against
 *
 * - **Reaching internal infrastructure.** Every hostname is resolved and
 *   every resulting address checked before connecting; loopback, private,
 *   link-local (including the `169.254.169.254` cloud-metadata address),
 *   and other non-public ranges are refused. The check runs again on
 *   every redirect hop.
 * - **Credential exfiltration through the tool.** No caller headers, no
 *   cookies, no authorization, and URLs carrying `user:password@` are
 *   refused. The tool cannot be pointed at an internal API and told to
 *   authenticate.
 * - **Redirect laundering.** Cross-host redirects are not followed. The
 *   target comes back to the model as a URL to consider, so a host on
 *   `allowedDomains` cannot bounce the fetch to one that is not.
 * - **Unbounded reads.** Byte cap, character cap, redirect cap, and a
 *   deadline, all applied per call.
 * - **Unbounded CPU.** Extraction and conversion are synchronous and
 *   share the event loop with every route in the process, so the byte cap
 *   defaults below the point where conversion cost turns superlinear, and
 *   a hard ceiling refuses oversized HTML outright rather than blocking.
 *
 * ## What it does NOT protect against
 *
 * These are the deployer's to close, and are stated plainly rather than
 * half-built:
 *
 * - **DNS rebinding.** The address check and the connection resolve the
 *   hostname independently, so a resolver that answers differently
 *   between the two defeats the guard. Pinning the vetted address into
 *   the connection needs a runtime hook with no Bun equivalent. Close it
 *   with an egress proxy or a network policy.
 * - **Prompt injection from fetched content.** Everything returned is
 *   attacker-controlled text flowing into a model's context. Treat tool
 *   output as untrusted input and keep the agent's other tools scoped
 *   accordingly.
 * - **Private services on public addresses.** Indistinguishable here
 *   from any other public host; bound them with `allowedDomains`.
 * - **Cost and rate limits at the far end.** No per-host throttling.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     WebFetch: webFetch({ allowedDomains: ["docs.example.com"] }),
 *   },
 * });
 * ```
 *
 * @remarks
 * The result shape is additive by design: an optional lossy reduction
 * layer (a `prompt` input and a reduced-output field, see
 * routecraftjs/routecraft#569) must be able to land without changing any
 * field documented here.
 */
export function webFetch(options: WebFetchOptions = {}): FnOptions {
  const bounds: FetchBounds = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    allowedDomains: normaliseDomains(options.allowedDomains),
    acceptedTypes: ACCEPTED_TYPES,
  };
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  assertPositiveInteger("maxBytes", bounds.maxBytes);
  assertPositiveInteger("maxLength", maxLength);
  assertPositiveInteger("timeoutMs", bounds.timeoutMs);
  if (!Number.isInteger(bounds.maxRedirects) || bounds.maxRedirects < 0) {
    throw rcError("RC5003", undefined, {
      message: `webFetch: maxRedirects must be a non-negative integer, received ${bounds.maxRedirects}.`,
    });
  }

  return {
    description:
      "Reads a web page and returns its content as markdown. Use it to read documentation, articles, and other public pages. Long pages come back truncated with an offset you can pass back to read the next section.",
    input: webFetchInputSchema,
    tags: ["read-only", "idempotent"] satisfies KnownTag[],
    handler: (input: WebFetchInput, ctx: FnHandlerContext) =>
      run(input, ctx, bounds, maxLength),
  } as FnOptions;
}

/**
 * Integers, not merely positive numbers. A fractional `maxLength` would
 * advertise a fractional `offset` back to the model, which its own schema
 * rejects, and a fractional `timeoutMs` makes `AbortSignal.timeout` throw
 * a raw range error at call time rather than here.
 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw rcError("RC5003", undefined, {
      message: `webFetch: ${name} must be a positive integer, received ${value}.`,
    });
  }
}

/**
 * Normalise, validate, and freeze the host allowlist at registration.
 *
 * Copying matters as much as validating: the caller's array would
 * otherwise stay live, so a later push into it would silently widen the
 * egress allowlist of an already-registered tool. Rejecting malformed
 * entries here turns a typo into a startup error rather than an
 * every-call `AI2001` that reads like a genuine host mismatch.
 */
function normaliseDomains(domains: string[] | undefined): readonly string[] {
  if (!domains) return Object.freeze([]);
  return Object.freeze(
    domains.map((raw, index) => {
      const bare = raw.trim().replace(/^\./, "").replace(/\.$/, "");
      // "@" matters most here: URL reads everything before it as
      // userinfo, so an entry of "example.com@evil.com" would silently
      // canonicalise to an allowlist entry for evil.com.
      if (bare === "" || /[:/?#*@\s]/.test(bare)) {
        throw rcError("RC5003", undefined, {
          message:
            `webFetch: allowedDomains[${index}] must be a bare hostname such as ` +
            `"example.com", received "${raw}".`,
        });
      }
      // Through URL so an internationalised entry is stored punycoded,
      // which is the form `url.hostname` will present at match time.
      try {
        return new URL(`https://${bare}`).hostname;
      } catch (cause) {
        throw rcError("RC5003", cause, {
          message:
            `webFetch: allowedDomains[${index}] is not a usable hostname, ` +
            `received "${raw}".`,
        });
      }
    }),
  );
}

async function run(
  input: WebFetchInput,
  ctx: FnHandlerContext,
  bounds: FetchBounds,
  maxLength: number,
): Promise<WebFetchResult> {
  const resource = await fetchResource(input.url, bounds, ctx.abortSignal);

  if (resource.crossHostRedirect) {
    return {
      url: resource.url,
      content:
        `${resource.url} redirects to a different host: ${resource.crossHostRedirect}\n\n` +
        `Cross-host redirects are not followed automatically. Call this tool again with that URL if you want its content.`,
      truncated: false,
      totalLength: 0,
      redirectedTo: resource.crossHostRedirect,
    };
  }

  const { title, markdown } = await render(resource);
  return bound(resource, title, markdown, input.offset ?? 0, maxLength);
}

/**
 * Turn a fetched resource into markdown, skipping extraction entirely
 * when the server already returned text. A host that honours the
 * markdown-first `Accept` header hands back exactly what the model
 * should read, and running that through an HTML extractor would only
 * damage it.
 */
async function render(
  resource: FetchedResource,
): Promise<{ title?: string; markdown: string }> {
  if (TEXT_TYPES.has(resource.contentType)) {
    return { markdown: resource.body.trim() };
  }
  if (HTML_TYPES.has(resource.contentType)) {
    if (resource.body.length > MAX_EXTRACTABLE_CHARS) {
      throw rcError("AI2003", undefined, {
        message:
          `WebFetch: ${resource.url} is ${resource.body.length} characters of HTML, ` +
          `past the ${MAX_EXTRACTABLE_CHARS} this tool will extract. Extraction is ` +
          `synchronous, so attempting it would stall the process. Fetch this page ` +
          `with a purpose-built route instead.`,
      });
    }
    const article = await extractArticle(resource.body, resource.url);
    return {
      ...(article.title ? { title: article.title } : {}),
      markdown: await toMarkdown(article.html),
    };
  }
  // Backstop. The fetch step refuses anything outside ACCEPTED_TYPES on
  // the response headers, so reaching here means the two have drifted.
  throw rcError("AI2003", undefined, {
    message:
      `WebFetch: ${resource.url} returned unsupported content type ` +
      `"${resource.contentType}". This tool reads HTML, markdown, and plain text.`,
  });
}

/**
 * Pull `index` back by one when it would land between the halves of a
 * surrogate pair, so an astral character is never split across two
 * responses. JavaScript string indices count UTF-16 code units, and
 * slicing on a raw count can otherwise hand the model a lone half of an
 * emoji and open the next page with the other half.
 */
function codePointBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  const splitsPair =
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    code >= 0xdc00 &&
    code <= 0xdfff;
  return splitsPair ? index - 1 : index;
}

/**
 * Apply the character bound and, when it bites, append the notice that
 * makes the truncation visible in the content itself.
 */
function bound(
  resource: FetchedResource,
  title: string | undefined,
  markdown: string,
  offset: number,
  maxLength: number,
): WebFetchResult {
  const totalLength = markdown.length;

  // Guarding on the offset alone rather than also on totalLength: an
  // empty document read from the start is legitimate, but any non-zero
  // offset into one is a stale continuation handle and gets the same
  // error a non-empty page would give.
  if (offset > 0 && offset >= totalLength) {
    throw rcError("AI2003", undefined, {
      message:
        `WebFetch: offset ${offset} is past the end of ${resource.url}, ` +
        `which is ${totalLength} characters long.`,
    });
  }

  const requestedEnd = Math.min(offset + maxLength, totalLength);
  const boundedEnd = codePointBoundary(markdown, requestedEnd);
  // Pulling back off a surrogate pair must never leave the window empty:
  // a maxLength of 1 against an astral first character would otherwise
  // return nothing and hand back the offset it started from, so the model
  // would page forever without reading a character. Take the whole pair.
  const end =
    boundedEnd === offset && requestedEnd > offset
      ? Math.min(requestedEnd + 1, totalLength)
      : boundedEnd;
  const slice = markdown.slice(offset, end);
  const truncated = end < totalLength;

  if (!truncated && offset === 0 && !resource.bodyTruncated) {
    return {
      url: resource.url,
      ...(title ? { title } : {}),
      content: slice,
      truncated: false,
      totalLength,
    };
  }

  const notes: string[] = [];
  if (truncated || offset > 0) {
    notes.push(
      `Showing characters ${offset} to ${end} of ${totalLength}${
        resource.bodyTruncated ? " (or more, see below)" : ""
      }.`,
    );
  }
  if (truncated) {
    notes.push(`Call this tool again with offset=${end} for the next section.`);
  }
  if (resource.bodyTruncated) {
    notes.push(
      `The page also exceeded this tool's download limit, so the source itself was cut short: content past that point was never read.`,
    );
  }

  return {
    url: resource.url,
    ...(title ? { title } : {}),
    content: `${slice}\n\n---\n[WebFetch: ${notes.join(" ")}]`,
    truncated,
    totalLength,
    ...(truncated ? { nextOffset: end } : {}),
  };
}
