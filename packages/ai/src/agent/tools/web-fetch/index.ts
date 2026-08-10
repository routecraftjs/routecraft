import { rcError, type KnownTag } from "@routecraft/routecraft";
import type { FnHandlerContext, FnOptions } from "../../../fn/types.ts";
import { toMarkdown } from "./convert.ts";
import { extractArticle } from "./extract.ts";
import { fetchResource } from "./fetch.ts";
import { webFetchInputSchema, type WebFetchInput } from "./schema.ts";

/** Bytes read off the wire before the response is cut short. */
const DEFAULT_MAX_BYTES = 5_000_000;
/** Markdown characters returned in one response. */
const DEFAULT_MAX_LENGTH = 50_000;
/** Deadline for the whole fetch, redirects included. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Same-host redirect hops followed before giving up. */
const DEFAULT_MAX_REDIRECTS = 5;

/** Media types returned verbatim, with no extraction or conversion. */
const TEXT_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "",
]);
/** Media types run through extraction and markdown conversion. */
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** Registration-time configuration for {@link webFetch}. */
export interface WebFetchOptions {
  /**
   * Hosts this tool may read. An entry matches its exact host and any
   * subdomain of it. Empty or omitted means any public host, which is
   * the drop-in-compatible default but the weaker posture: set it when
   * the agent's job only needs a known set of sites.
   */
  allowedDomains?: string[];
  /** Bytes read off the wire per fetch. Defaults to 5,000,000. */
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
  const bounds = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    allowedDomains: options.allowedDomains ?? [],
  };
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  assertPositive("maxBytes", bounds.maxBytes);
  assertPositive("maxLength", maxLength);
  assertPositive("timeoutMs", bounds.timeoutMs);
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

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw rcError("RC5003", undefined, {
      message: `webFetch: ${name} must be a positive number, received ${value}.`,
    });
  }
}

async function run(
  input: WebFetchInput,
  ctx: FnHandlerContext,
  bounds: Parameters<typeof fetchResource>[1],
  maxLength: number,
): Promise<WebFetchResult> {
  const resource = await fetchResource(input.url, bounds, ctx.abortSignal);

  if (resource.crossHostRedirect) {
    return {
      url: resource.url,
      content:
        `${resource.url} redirects to a different host: ${resource.crossHostRedirect}\n\n` +
        `Cross-host redirects are not followed automatically. Call WebFetch again with that URL if you want its content.`,
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
  resource: Awaited<ReturnType<typeof fetchResource>>,
): Promise<{ title?: string; markdown: string }> {
  if (TEXT_TYPES.has(resource.contentType)) {
    return { markdown: resource.body.trim() };
  }
  if (HTML_TYPES.has(resource.contentType)) {
    const article = await extractArticle(resource.body, resource.url);
    return {
      ...(article.title ? { title: article.title } : {}),
      markdown: await toMarkdown(article.html),
    };
  }
  throw rcError("AI2003", undefined, {
    message:
      `WebFetch: ${resource.url} returned unsupported content type ` +
      `"${resource.contentType}". This tool reads HTML, markdown, and plain text.`,
  });
}

/**
 * Apply the character bound and, when it bites, append the notice that
 * makes the truncation visible in the content itself.
 */
function bound(
  resource: Awaited<ReturnType<typeof fetchResource>>,
  title: string | undefined,
  markdown: string,
  offset: number,
  maxLength: number,
): WebFetchResult {
  const totalLength = markdown.length;

  if (offset >= totalLength && totalLength > 0) {
    throw rcError("AI2003", undefined, {
      message:
        `WebFetch: offset ${offset} is past the end of ${resource.url}, ` +
        `which is ${totalLength} characters long.`,
    });
  }

  const end = Math.min(offset + maxLength, totalLength);
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
    notes.push(`Call WebFetch again with offset=${end} for the next section.`);
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
