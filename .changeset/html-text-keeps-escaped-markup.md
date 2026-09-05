---
"@routecraft/routecraft": minor
---

`html()` text extraction changes what it returns: escaped markup is no longer deleted, and whitespace inside the match is no longer collapsed (#719).

`extract: "text"`, `"innerText"` and `"textContent"` ran a tag-stripping regex over text cheerio had already decoded. At that point there is no markup left to strip, so the regex could only match content the page had escaped on purpose: `<pre>type X = Array&lt;string&gt;;</pre>` came back as `type X = Array;`, with no signal to the caller that anything had been dropped. Removing it changes two things, on all three roles that extract (transformer, source, enricher).

**Whitespace inside the match now survives.** This is the half that reaches the most routes. The stripping step also collapsed every run of whitespace to a single space, so any page with ordinary indentation was being flattened:

```
<div class="card">
  <h2>Getting started</h2>
  <p>Install the   package
     and run it.</p>
</div>

before: "Getting started Install the package and run it."
after:  "Getting started\n  Install the   package\n     and run it."
```

Only the ends are trimmed, per matched element in the array case. A `<pre>` therefore keeps its newlines and indentation too, which is the code-sample case that motivated the fix.

**Escaped markup now survives.** `Array&lt;string&gt;` extracts as `Array<string>` rather than `Array`. The value is decoded and unsanitised: a page that escaped a payload gets it back as live markup, so escape it at the sink before writing extracted text into HTML or into any line-structured format.

**You are affected if** a route compares extracted text to a literal, keys or hashes on it, validates it against a schema, or writes it to a line-oriented sink. There is no compile error and no new option to notice. Collapse it in the route where you want the old shape:

```ts
.transform(html<unknown, string>({ selector: '.card', extract: 'text' }))
.transform((text) => text.replace(/\s+/g, ' '))
```

`<style>` and `<script>` subtrees are still removed from text extraction, which is the part that genuinely needed handling. `extract: "html"`, `"outerHtml"` and `"attr"` are unchanged.
