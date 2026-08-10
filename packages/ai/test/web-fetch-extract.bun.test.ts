import { describe, expect, test } from "bun:test";
import { extractArticle } from "../src/agent/tools/web-fetch/extract.ts";

/**
 * Extraction tests for the WebFetch render pipeline's middle step.
 *
 * Runs against the real `linkedom` and `@mozilla/readability`, because
 * the behaviour that matters here is precisely where those two disagree
 * with their own documentation.
 */
/**
 * Container Readability wraps every successful extraction in. Its
 * presence or absence is the only reliable way to tell an extracted
 * result from a body fallback, since both can carry the same markup.
 */
const READABILITY_WRAPPER = 'id="readability-page-1"';

describe("WebFetch extraction", () => {
  /**
   * @case A readable article is reduced to its content
   * @preconditions HTML with navigation chrome around an article body
   * @expectedResult The article prose survives and the navigation does not
   */
  test("extracts the readable region", async () => {
    const result = await extractArticle(
      `<html><head><title>Guide</title></head><body>
         <nav><a href="/x">Skip me</a></nav>
         <article>
           <h1>Installing</h1>
           <p>Run the installer, then restart the service so it picks up the new configuration file.</p>
           <p>The widget listens on port 8080 by default, which you can change in the config.</p>
         </article>
       </body></html>`,
      "http://example.test/guide",
    );

    expect(result.title).toBe("Guide");
    expect(result.html).toContain("restart the service");
    expect(result.html).not.toContain("Skip me");
  });

  /**
   * @case An element-dense document is answered with its body rather than an error
   * @preconditions HTML carrying more elements than the extraction ceiling allows
   * @expectedResult Returns the raw body instead of throwing, and carries none of Readability's wrapper, proving extraction was skipped rather than merely surviving
   */
  test("falls back to the body past the element ceiling", async () => {
    const dense = `<html><head><title>Dense</title></head><body>${"<p>x</p>".repeat(30_001)}</body></html>`;

    const result = await extractArticle(dense, "http://example.test/dense");

    expect(result.title).toBe("Dense");
    expect(result.html).toContain("<p>x</p>");
    // Readability wraps everything it returns in this container, so its
    // absence is what distinguishes the fallback from a successful parse.
    expect(result.html).not.toContain(READABILITY_WRAPPER);
  });

  /**
   * @case Readability's own element guard is inert under linkedom, so ours has to do the work
   * @preconditions A document with many elements, queried both ways linkedom exposes
   * @expectedResult getElementsByTagName("*") reports zero while querySelectorAll("*") reports the real count, which is why the ceiling is enforced with the latter
   */
  test("documents why the element count uses querySelectorAll", async () => {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(
      `<html><body>${"<p>x</p>".repeat(200)}</body></html>`,
      { location: "http://example.test/" },
    );

    expect(document.getElementsByTagName("*").length).toBe(0);
    expect(document.querySelectorAll("*").length).toBeGreaterThan(200);
  });

  /**
   * @case A page Readability cannot find an article in still returns its markup
   * @preconditions A document whose only body content is a script, which Readability parses to null
   * @expectedResult The body is returned rather than an empty result or an error
   */
  test("falls back to the body when Readability declines", async () => {
    const result = await extractArticle(
      `<html><head><title>Index</title></head><body><script>load()</script></body></html>`,
      "http://example.test/index",
    );

    expect(result.title).toBe("Index");
    expect(result.html).toContain("<script>");
    expect(result.html).not.toContain(READABILITY_WRAPPER);
  });

  /**
   * @case A link index is extracted rather than falling back, which is why the decline case needs different input
   * @preconditions A list of links, which Readability accepts and wraps rather than declining
   * @expectedResult The result carries Readability's wrapper, pinning the boundary between the two paths
   */
  test("extracts a link index rather than declining on it", async () => {
    const result = await extractArticle(
      `<html><head><title>Index</title></head><body><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></body></html>`,
      "http://example.test/index",
    );

    expect(result.html).toContain(READABILITY_WRAPPER);
  });
});
