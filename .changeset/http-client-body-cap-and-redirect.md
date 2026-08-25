---
"@routecraft/routecraft": minor
---

Two options on the `http()` client: `maxBodySize` and `redirect`.

**`maxBodySize` caps the response body, defaulting to 10 MB.** This is a behaviour change for any route already moving larger payloads through `http()`: raise the option on that call to keep working. The name and the number are the http plugin's inbound `maxBodySize`, deliberately, so one concept means one thing on both sides of the framework.

The cap is enforced at the two moments the size can be known. A declared `Content-Length` above the cap is refused before the body is read; otherwise the body streams and the running count is checked as it arrives, so the response is abandoned the moment the ceiling is crossed. The second arm is what bounds memory rather than only bounding what the route receives, and it is the only one available for a chunked response that declares nothing.

Exceeding the cap fails the exchange with the new `RC5061`, naming the option, the limit, and the size that was declared or counted. The body is never truncated to fit: half a JSON document parses as though it were whole, and a route acting on it would be quietly wrong instead of loudly failed. The cap applies to error responses too, and the size error names the status so the HTTP failure stays legible.

**`redirect: "follow" | "manual" | "error"` mirrors the platform, and the default stays `"follow"`.** Nothing changes for a route that does not set it.

`"manual"` returns the 3xx itself with `Location` readable, so a route that validated a URL can re-run its own rule on each hop instead of having the adapter walk somewhere the route never approved. A 3xx under `"manual"` does not trip `throwOnHttpError`, because it is the outcome the route asked for; every other non-2xx still does.

```ts
.enrich(http({ url: (ex) => ex.body.url, maxBodySize: 2_000_000, redirect: 'manual' }))
.choice(when(isRedirect, revalidateAndFollow))
```

`isRedirect` and `HTTP_REDIRECT_STATUSES` are exported alongside the option, because the adapter already owns that rule and the obvious hand-rolled version (`status >= 300 && status < 400`) includes `304`, which is a cache answer rather than a hop. What to do on a hop stays the route's own business.

`maxBodySize` accepts `Infinity` as the named opt-out; zero and negatives are refused rather than read as "no limit".

The option reports what happened and hands control back. It carries no allowlist, no address classification and no cross-host rules: whether a URL is acceptable is the route's decision, where a reader can see the rule and change it. `.standards/package-boundaries.md` section 6.1 records that as a general rule for framework additions.
