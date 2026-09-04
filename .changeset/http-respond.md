---
"@routecraft/routecraft": minor
---

`http({ respond })` decides when the caller is answered, so a webhook can acknowledge before the pipeline runs (#710).

An `http()` source answered the caller with the pipeline's result, which is right for an API and wrong for a webhook whose work outlasts the sender's patience. Bird treats anything past a few seconds as a failed delivery and redelivers under the same `webhook-id` for about 27 hours, Stripe and Svix behave the same way, and the Standard Webhooks specification says to acknowledge before processing. Route authors worked around this with two routes and a `direct()` hand-off, a split that existed only because the framework had no way to answer early.

`respond` is a function called once per request, after every gate has passed and after the pipeline has been started. The response is sent when it returns, so the function decides whether the caller waits:

```ts
// Acknowledge, then process: `finished` is never touched.
.from(http({ path: '/hooks/bird', method: 'POST', respond: () => ({ status: 202 }) }))

// Answer with the result, which is what omitting the option does.
respond: async ({ finished }) => ({ status: 200, body: (await finished).body })
```

It receives `{ request, finished }` and returns `{ status, headers?, body? }`, which the dispatcher serialises by the same rules as a pipeline result. `request` is the parsed request the route sees, never the `Request`, whose body has already been read to parse it and verify its signature. Omitting `respond` entirely keeps the previous behaviour exactly, including streaming and the suspension acknowledgement, which a responder does not carry.

Every gate runs before the responder: a bad signature is still a 401 and the responder never runs.

**Failures move to the error channel.** Once a responder has answered, the response is gone, so a pipeline failure reaches the route's `.error()` handler and the ordinary error events (`route:error`, `context:error`, `route:exchange:failed`) and nowhere else. Give such a route an `.error()` handler.

**Shutdown still waits.** A detached run is the route's in-flight work from the moment it starts, and the context drains that work before any listener closes. The pipeline is started before the responder is called, which is what puts it inside that drain.

**Two refusals, both deliberately wider than they look.** Nothing can tell before calling a responder whether it will await the pipeline, since that is decided inside the function, so both guards cover every responder including one that would have been safe. A responder on a route that also uses `.batch()` is refused (`RC5003`) at subscribe, because a batched message waits in the buffer instead of counting as in-flight work and would be discarded at shutdown after the answer had gone. And once shutdown has begun a responder is not called at all: the request answers `503` with `retry-after` so the sender redelivers to the next instance.

**Bound admission, not execution.** Answering early removes the backpressure the caller's wait provided. `.throttle()` and `.concurrency()` before `.from()` still apply, but their defaults (`mode: "queue"` with no `maxQueue`, `mode: "delay"`) cap how many run at once while letting the wait line grow without limit, which a redelivery burst turns into unbounded heap. Give `.concurrency()` a `maxQueue`, or `mode: "reject"`, on any route that answers early. Note also that a refusal only reaches the sender when it happens before the answer: `.authorize()` runs inside the pipeline, so a denial stops the work without the caller being able to tell it from acceptance.

**OpenAPI.** A route with a responder advertises no success code, because the document cannot know what a function returns; its rejection codes stay, since every gate still runs ahead of it. A route that wants documented success codes omits the option.

Not included, by design: no retry, replay, or persistence of a detached delivery. One lost to a crash is the sender's redelivery to make, which is what deduplicating on `webhook-id` in the route is for.
