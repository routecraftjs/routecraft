import { describe, expect, test } from "bun:test";
import { toMarkdown } from "../src/agent/tools/web-fetch/convert.ts";

/**
 * Conversion tests for the WebFetch render pipeline's final step.
 *
 * Exercised directly rather than through the tool, because a
 * `text/markdown` response is passed through verbatim and never reaches
 * the converter, so a tool-level test would assert nothing about it.
 * Runs against the real `turndown`.
 */
describe("WebFetch markdown conversion", () => {
  /**
   * @case Blank-line collapsing does not reformat fenced code samples
   * @preconditions HTML whose pre/code block separates two statements with a run of blank lines, surrounded by prose paragraphs
   * @expectedResult The code block keeps its internal blank run, proving the collapse skipped the fenced region
   */
  test("preserves blank lines inside fenced code blocks", async () => {
    const markdown = await toMarkdown(
      `<article>
         <p>Intro</p>
         <pre><code class="language-js">const a = 1;


const b = 2;</code></pre>
         <p>Tail</p>
       </article>`,
    );

    expect(markdown).toContain("```js");
    expect(markdown).toContain("const a = 1;\n\n\nconst b = 2;");
  });

  /**
   * @case Blank-line runs in prose are still collapsed
   * @preconditions HTML with elements that turndown drops, leaving long blank runs between paragraphs
   * @expectedResult No run of three or more newlines survives outside a fenced block
   */
  test("collapses blank-line runs in prose", async () => {
    const markdown = await toMarkdown(
      `<article>
         <p>One</p>
         <script>ignored()</script>
         <style>.x{}</style>
         <p>Two</p>
       </article>`,
    );

    expect(markdown).toContain("One");
    expect(markdown).toContain("Two");
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  /**
   * @case A literal triple backtick in prose does not mis-pair with a real fence
   * @preconditions HTML whose prose mentions a triple backtick inline, followed by a genuine code block containing a blank run
   * @expectedResult The real block keeps its blank run, proving the fence match is anchored to line starts rather than pairing with the inline mention
   */
  test("does not mis-pair an inline triple backtick with a real fence", async () => {
    const markdown = await toMarkdown(
      `<article>
         <p>Fence code with <code>\`\`\`</code> like so.</p>
         <p>Filler</p>
         <pre><code class="language-js">const a = 1;


const b = 2;</code></pre>
       </article>`,
    );

    expect(markdown).toContain("const a = 1;\n\n\nconst b = 2;");
  });

  /**
   * @case Script and style content never reaches the model
   * @preconditions HTML carrying script and style elements inside the converted region
   * @expectedResult Neither body appears in the markdown
   */
  test("drops script and style bodies", async () => {
    const markdown = await toMarkdown(
      `<article><p>Visible</p><script>secret()</script><style>.a{color:red}</style></article>`,
    );

    expect(markdown).toContain("Visible");
    expect(markdown).not.toContain("secret()");
    expect(markdown).not.toContain("color:red");
  });
});
