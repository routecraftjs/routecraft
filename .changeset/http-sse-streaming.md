---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Server-Sent Events and streaming responses on the http source (#388).

A route can now answer with a stream. The dispatcher rejected one with `RC5018` and the comment "SSE deferred"; that gate is gone and the two body shapes it refused have become two rows in the response-convention table.

## Framing

An `AsyncIterable` body answers `text/event-stream; charset=utf-8` with `Cache-Control: no-cache`, one SSE frame per yielded value. An object carrying a `data` property is an event descriptor, so `event`, `id` and `retry` are read from it; any other value becomes `data: <JSON>`. Strings and `Uint8Array`s pass through as raw bytes, which is the escape hatch for a hand-built frame, an SSE comment, or a different line format entirely.

A `ReadableStream` body passes through unframed as `application/octet-stream`, with the caller owning every header. Framing follows the body type rather than the content type, so a route that overrides the content type to `application/x-ndjson` yields strings and writes its own newlines.

```ts
craft()
  .id("order-events")
  .from(http({ path: "/orders/:id/events", method: "GET" }))
  .transform(async function* (_, ex) {
    for await (const update of watchOrder(ex.headers["routecraft.http.params"].id)) {
      yield { event: "update", id: update.sequence, data: update };
    }
  })
  .to(noop());
```

There is no `sse()` adapter, and there will not be one. SSE is an HTTP response, not a protocol: no upgrade, the same request/response shape, one exchange per request with the pre-from chain applying once at entry. WebSocket is genuinely different and gets its own adapter.

## Lifecycle

A client that disconnects cancels the route's iterator, visible as a `return()` into a generator's `finally` or a `for await` exiting. `plugin:http:request:completed` is held back until the stream closes, so `durationMs` spans request receipt to stream end. Open streams end when the context begins stopping rather than being waited out by the listener's grace window, and a streaming request claims a per-request idle-timeout exemption so a quiet stream is not reaped.

**Resilience operations apply up to the first byte, and no further.** Once the status line is sent the response cannot be replayed: `retry()` cannot re-run a half-delivered stream, and `timeout()` bounds time to first byte rather than the life of the stream.

Every event stream opens with a `: open` comment. Neither runtime puts the status line on the wire before the body's first chunk, so without it a stream that starts quiet leaves the client's `fetch` unresolved and an `EventSource` without its `open`.

`Last-Event-ID` arrives on the exchange like any other request header. Replay is the route's own business, since only the route knows what its ids mean.

## Streaming an agent

`agent({ stream: true })` produces the token deltas instead of the consolidated `AgentResult`, so a route serving a model's reply over SSE is one declarative step:

```ts
craft()
  .id("chat-stream")
  .input({ body: ChatInput })
  .from(http({ path: "/chat/stream", method: "POST" }))
  .to(
    agent({
      system: aria,
      user: (ex) => (ex.body as z.infer<typeof ChatInput>).message,
      stream: true,
    }),
  );
```

The queue and the abort that closes it live inside the adapter beside `onDelta`, and abandoning the stream aborts the run, so a client that disconnects mid-answer stops the model. Only the `stream: true` call site widens its declared output; every other agent route still says `AgentResult`. Setting `stream` alongside `onDelta` is refused at construction, since they are the pull and push spellings of one thing.

## The ops event tail

`GET /ops/events` tails the context event bus as SSE, gated by a new `events` tier (`ops:events` is the documented scope name). Its own tier rather than a corner of introspection: a route listing describes an app's shape, while the tail carries what it is doing right now. A bounded buffer keeps a slow reader from growing memory without bound, and a dropped-count frame says so rather than leaving a silent gap.

## Bounds on a streaming listener

A streaming response is exempt from the idle reaper, which was the only limit
on how long a connection could stay open, so two options on a server
definition put a ceiling back. `idleTimeout` (a `Duration`, default `"255s"`)
sets the reap window for ordinary connections and is refused above Bun's 255s
ceiling rather than clamped, because a config honoured on Node and capped on
Bun means two different things depending on where it runs.
`maxStreamingRequests` (default `500`) caps the streams one listener carries
and answers `503` with `Retry-After` past it. A backstop below the
file-descriptor cliff, the same kind of number as `maxBodySize`'s 10 MB, and
a complement to `.concurrency({ max, mode: "reject" })` rather than a
replacement: the route operation shapes one endpoint, the listener cap catches
the routes that never thought about it. It counts requests that claim a slot,
so a surface declaring itself long-lived for every request (today, the MCP
mount) is not counted and the cap is not a total.

A stream admitted on an expiring credential now closes at expiry, through the
same `isPrincipalExpired` boundary the rest of the framework checks. No 401 is
attempted, because one cannot follow a `200` already on the wire; an
`EventSource` reconnects by specification and meets ordinary admission. A
browser client authenticates through `apiKey({ in: "query" })`, documented
with the caveat that query strings reach access logs and browser history.

## Notes

`RC5018` keeps its meaning for request-side refusals (413 and 400); only the streaming-response arm is gone. `HttpMountContext` gains `claimStreamingSlot()`, which exempts a request from the reaper and counts it against the cap in one decision, returning a release or refusing. `plugin:http:request:completed` gains an optional `error`, so a stream that breaks after its status line is sent stops being counted as a `200`. The cycle-safe JSON the telemetry sink kept private moved to a shared module and now identifies framework objects by their brand rather than by key names, matching how `logger.ts` already discriminates them. `anySignal` is exported for composing cancellation scopes, replacing six hand-rolled variants that had drifted on the empty case.
