import { loadOptionalPeer } from "@routecraft/routecraft";

/**
 * The extract step of the WebFetch pipeline: reduce a full HTML document
 * to the part a reader came for, discarding navigation, sidebars, and
 * boilerplate.
 *
 * Separate from fetching and from markdown conversion so the three can
 * be recombined. A browser-backed variant replaces the fetch step and
 * keeps this one; a reader-API variant replaces both and keeps neither.
 */

/**
 * Element ceiling for extraction.
 *
 * The caller's byte cap bounds input size, but Readability's candidate
 * scoring is driven by element count rather than bytes, so markup made of
 * very many tiny elements is expensive at a size the byte cap allows.
 *
 * Enforced here rather than through Readability's own `maxElemsToParse`,
 * which is dead under linkedom: that guard counts through
 * `getElementsByTagName("*")`, which linkedom answers with an empty list,
 * so the option never fires. `querySelectorAll("*")` counts correctly.
 */
const MAX_ELEMS_TO_PARSE = 30_000;

/** Readable content pulled out of a page. */
export interface ExtractedDocument {
  /** Document title, when the page supplied one. */
  title?: string;
  /** HTML of the readable region, ready for markdown conversion. */
  html: string;
}

/**
 * `@mozilla/readability` is the extraction algorithm Firefox Reader View
 * uses, and `linkedom` supplies the DOM it needs without pulling in a
 * browser. Both are optional peers: a deployment that never registers
 * `WebFetch` should not carry them.
 */
const READABILITY_PEER = {
  adapterName: "WebFetch",
  packageName: "@mozilla/readability",
};
const LINKEDOM_PEER = { adapterName: "WebFetch", packageName: "linkedom" };

type ReadabilityModule = typeof import("@mozilla/readability");
type LinkedomModule = typeof import("linkedom");

interface Extractors {
  readability: ReadabilityModule;
  linkedom: LinkedomModule;
}

// Memoised on the promise, not the value: caching the value lets two
// concurrent first callers both past the guard and both run the import.
let extractors: Promise<Extractors> | null = null;

async function loadExtractors(): Promise<Extractors> {
  extractors ??= Promise.all([
    loadOptionalPeer(() => import("@mozilla/readability"), READABILITY_PEER),
    loadOptionalPeer(() => import("linkedom"), LINKEDOM_PEER),
  ]).then(([readability, linkedom]) => ({ readability, linkedom }));
  return extractors;
}

/**
 * Run Readability, answering `null` where it declines.
 *
 * It throws rather than returning `null` on some documents. Both outcomes
 * mean the same thing to the caller (no article found, use the body), so
 * collapsing them here keeps a page readable instead of failing the whole
 * tool call.
 */
function parseArticle(readability: ReadabilityModule, document: object) {
  try {
    return new readability.Readability(document as Document).parse();
  } catch {
    return null;
  }
}

/**
 * Extract the readable region of `html`.
 *
 * Readability declines on pages it cannot find an article in (link
 * indexes, dashboards, some SPAs). That is not an error: the caller
 * still wants whatever text is there, so the whole `<body>` is returned
 * instead. Callers cannot distinguish the two cases, deliberately, since
 * the useful output is the same shape either way.
 *
 * @param html - Raw HTML as fetched.
 * @param url - Document URL, used to resolve relative links.
 */
export async function extractArticle(
  html: string,
  url: string,
): Promise<ExtractedDocument> {
  const { readability, linkedom } = await loadExtractors();
  const { document } = linkedom.parseHTML(html, { location: url });

  const title = document.title?.trim() || undefined;

  // Checked before parsing, and answered with the body rather than an
  // error: an element-dense page is still worth reading, just not worth
  // scoring. Readability has not run yet here, so the document is
  // unmutated and its body can be read directly.
  if (document.querySelectorAll("*").length > MAX_ELEMS_TO_PARSE) {
    return {
      ...(title ? { title } : {}),
      html: document.body?.innerHTML ?? "",
    };
  }

  const article = parseArticle(readability, document);

  const extracted = article?.content?.trim();
  if (extracted) {
    const articleTitle = article?.title?.trim() || title;
    return {
      ...(articleTitle ? { title: articleTitle } : {}),
      html: extracted,
    };
  }

  // Re-parse rather than keeping a copy of the body from before the call:
  // Readability mutates the document it is given, and serialising the
  // whole body up front would cost a full extra copy on every page just
  // to have a fallback ready for the few that need one.
  const { document: pristine } = linkedom.parseHTML(html, { location: url });
  return {
    ...(title ? { title } : {}),
    html: pristine.body?.innerHTML ?? "",
  };
}
