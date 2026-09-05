---
"@routecraft/routecraft": patch
---

`html()` text extraction no longer deletes escaped markup (#719).

`extract: "text"`, `"innerText"` and `"textContent"` ran a tag-stripping regex over text cheerio had already decoded. At that point there is no markup left to strip, so the regex could only match content the page had escaped on purpose: `<pre>type X = Array&lt;string&gt;;</pre>` came back as `type X = Array;`, with no signal to the caller that anything had been dropped.

**Behaviour change.** Two things are different for the three text extract modes:

- Escaped markup survives. `Array&lt;string&gt;` now extracts as `Array<string>` rather than `Array`.
- Whitespace inside the match is preserved. The stripping step also collapsed every run of whitespace to a single space, which flattened a `<pre>` to one line; a multi-line code sample now keeps its newlines and indentation. Leading and trailing whitespace is still trimmed.

`<style>` and `<script>` subtrees are still removed from text extraction, which is the part that genuinely needed handling. `extract: "html"`, `"outerHtml"` and `"attr"` are unchanged.
