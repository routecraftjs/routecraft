---
"@routecraft/ai": minor
---

Built-in `WebFetch` agent tool: read a URL, get bounded markdown (#341).

`webFetch()` is a fn factory you assign a tool name in `agentPlugin({ functions })`, alongside `currentTime()` and `directTool()`. It is deliberately not in any default set: it performs network egress on a URL the model chooses, so registering it is a decision someone makes. Naming it `WebFetch` matches Claude Code, so a Claude agent file referencing that tool resolves without remapping.

**Bounds are CPU bounds, not just memory bounds.** Extraction and markdown conversion are synchronous and share the event loop with every route, consumer, and timer in the process, and turndown's cost is superlinear in block-element count: on block-heavy HTML, 250 KB converts in ~0.4s, 500 KB in ~1.7s, and 1 MB in ~12s. `maxBytes` therefore defaults to 500,000, below that knee, and a separate hard ceiling refuses extraction with `AI3003` above 600,000 characters of HTML so raising `maxBytes` cannot silently configure the bound away.

**Bounded, never summarised.** Input is `{ url, offset? }`. Output carries the markdown plus `truncated`, `totalLength`, and `nextOffset`. Truncation is the lossless floor: a page longer than `maxLength` comes back cut, and the content itself ends with a visible notice naming the untruncated length and the offset to resume from, so a model can tell a clipped page from a short one without reading a sibling field. Nothing is silently dropped. The result shape is additive by design, so the optional lossy reduction layer deferred to #569 lands without a break.

**Three separable steps.** Fetch, extract, and convert are distinct modules: a credential-free GET under the egress guard, `@mozilla/readability` over `linkedom`, then `turndown`. All three render peers are optional, loaded through `loadOptionalPeer` (`RC5017`). The seam is deliberate, so a browser-backed or reader-API-backed variant can later ship as a separately registered opt-in fn without touching the default's internals. The three-way render bake-off this ticket originally mandated was dropped: a built-in default can route content through neither an external service nor a required browser peer, which left one eligible candidate and nothing to rank. Render-quality measurement moves to #568, against the eval harness in #557.

**Security posture, stated both ways.** The guard resolves every hostname and classifies every resulting address before connecting, refusing loopback, private, link-local (including the `169.254.169.254` metadata address), and other non-public ranges with the new `AI3001`; it re-runs on every redirect hop. Cross-host redirects are not followed, so a permitted host cannot bounce a fetch somewhere it could not reach directly; the target comes back to the model as a URL to consider. Requests carry no caller headers, cookies, or authorization, and URLs with embedded credentials are refused. `allowedDomains` bounds reachable hosts by name.

What it does not cover is documented rather than half-built: DNS rebinding is open, because pinning the vetted address into the connection needs a runtime hook with no Bun equivalent, and closing it is a deployer's egress-proxy or network-policy job; fetched content is attacker-controlled text flowing into a model's context and carries prompt-injection risk; private services on public addresses are indistinguishable from any other public host.

New error codes `AI3001` (refused URL), `AI3002` (request failed), `AI3003` (unreadable content). `ipaddr.js` becomes a dependency of `@routecraft/ai` rather than an optional peer, so the egress guard can never be degraded by an absent install.
