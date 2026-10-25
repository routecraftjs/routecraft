---
"@routecraft/routecraft": minor
---

`http()` reads request cookies by name and sends several `Set-Cookie` fields in one response.

- **Reading.** `routecraft.http.cookies` carries the request's cookies by name, parsed from its `Cookie` header: each pair split on its first `=`, names and values trimmed, values exactly as sent, the first of a repeated name kept. A name the request did not send reads as `undefined`. A responder sees the same map as `request.cookies`.
- **Writing.** `routecraft.http.response.headers`, and a responder descriptor's `headers`, take `string | readonly string[]` per name (the new `HttpResponseHeaders` type). An array sends one field per entry, so a response can set one cookie and clear another; for any other name the entries are combined into one comma-separated field. Two spellings of one name in an override, such as `set-cookie` and `Set-Cookie`, now both arrive, where the last used to win alone. A single string behaves as before, on the buffered and the streaming response, under Bun and Node.
