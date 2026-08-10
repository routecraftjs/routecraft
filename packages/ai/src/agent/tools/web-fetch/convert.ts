import { loadOptionalPeer } from "@routecraft/routecraft";

/**
 * The convert step of the WebFetch pipeline: HTML to markdown.
 *
 * Last of the three separable steps. Every reader variant, whatever it
 * does upstream, ends here, which is what keeps their outputs comparable.
 */

const TURNDOWN_PEER = { adapterName: "WebFetch", packageName: "turndown" };

/**
 * The slice of turndown this module uses.
 *
 * Named structurally because turndown is CJS with `export =`: its types
 * resolve to the class in type position but to a namespace carrying
 * `.default` in value position, and the two disagree. Declaring the two
 * methods we call sidesteps that and costs nothing, since a wider
 * surface would be unused anyway.
 *
 * `@types/turndown` is still a required devDependency despite this. The
 * `import("turndown")` below needs a module declaration to exist at all,
 * and without one the import is an implicit `any` and `tsc` fails with
 * TS7016. Do not drop the dependency on the strength of this interface.
 */
interface MarkdownConverter {
  turndown(html: string): string;
  remove(filter: string[]): unknown;
}

interface TurndownConstructor {
  new (options?: Record<string, unknown>): MarkdownConverter;
}

// Memoised on the promise, not the value: caching the value lets two
// concurrent first callers both past the guard and both build a converter.
let converter: Promise<MarkdownConverter> | null = null;

/**
 * Build the shared converter once. Turndown instances carry no state
 * between `turndown()` calls, so one instance serves every fetch.
 */
async function loadConverter(): Promise<MarkdownConverter> {
  converter ??= buildConverter();
  return converter;
}

async function buildConverter(): Promise<MarkdownConverter> {
  const mod = await loadOptionalPeer(() => import("turndown"), TURNDOWN_PEER);
  // Accept either interop shape rather than betting on one runtime's.
  const namespace = mod as unknown as {
    default?: TurndownConstructor;
  };
  const TurndownService =
    namespace.default ?? (mod as unknown as TurndownConstructor);
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Readability leaves these in when they sit inside the article body,
  // and none of them renders as anything a model can use.
  service.remove(["script", "style", "noscript", "iframe", "form"]);
  return service;
}

/**
 * Convert `html` to markdown, collapsing the runs of blank lines that
 * turndown leaves behind where it dropped elements.
 */
export async function toMarkdown(html: string): Promise<string> {
  const service = await loadConverter();
  return service
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
