---
"@routecraft/routecraft": minor
---

`http({ responseBody: "bytes" })` stops the client corrupting binary responses (#712).

The `http()` client read every response through a `TextDecoder` and handed the route a string. There was no binary arm, so any body that is not valid UTF-8 was silently destroyed: each invalid sequence became U+FFFD and re-encoded as three bytes, and the original could not be recovered.

The corruption was asymmetric, which is why it survived. Measured on a real fetch:

```
jpeg:     8 bytes in, 16 out, identical=false
ogg/opus: 8 bytes in,  8 out, identical=true
```

An Ogg page header is the ASCII `OggS`, so a voice note passed through intact, while a JPEG's leading `ff d8 ff e0` did not. A route fetching both saw one work and the other fail, which reads as a problem with the file rather than with the transport. Until now such a route had to call `fetch` directly and reimplement the size cap and the timeout.

```ts
.enrich(http({ url: (ex) => ex.body.mediaUrl, responseBody: 'bytes' }))
```

`responseBody: "text"` is the default and is exactly today's behaviour. `"bytes"` hands the route a `Uint8Array` of what arrived, with no decoding and no JSON parsing, and the result type says `Uint8Array` without the call site repeating it as a type argument. `maxBodySize` and `timeout` apply unchanged, counting bytes as they arrive. With `throwOnHttpError`, a failing binary response reports its size and content type instead of quoting a decoded body, since decoding it for the message would reintroduce the corruption on the error path.

The mode is explicit rather than sniffed from the content type: sniffing would silently change the body type of an existing route that receives `application/octet-stream` today and reads it as a string.

**The `body` option's type is narrowed, which can break compilation.** It was `unknown | ((exchange) => unknown)`, and a union containing `unknown` collapses to `unknown`, so the callback form had no contextual parameter type and every call site annotated its own exchange by hand. The value arm is now a named `HttpRequestPayload` (string, number, boolean, null, object, `Uint8Array`, `ArrayBuffer`, `URLSearchParams`, `FormData`). Runtime behaviour is unchanged, so nothing that works today stops working, but a route passing a value outside that union will no longer compile. In exchange, `body: (ex) => ...` now gets `ex` typed as the route's exchange with no annotation.

Also fixed: the client set `Content-Type: application/json` when it found no header spelled exactly `Content-Type`, so a route that set `content-type` in lowercase got the header twice, arriving as `application/json, application/json`. The lookup is case-insensitive now.

Not included, by design: streaming the response body to the route. The body is buffered under the cap in both modes; a route that needs a stream is a different option.
