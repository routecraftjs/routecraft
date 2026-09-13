---
"@routecraft/routecraft": minor
---

`RC5065`: a caller's bad payload is its own error code, and the ops dispatch mount answers it 400 with the reason (#778).

`.input()` validation threw `RC5002`, the same code as `.output()` validation, a mid-pipeline `validate()` step and an empty aggregation. One code covering both a caller's mistake and the instance's meant no transport could tell them apart, so the ops dispatch mount answered every one of them `500 {"error":"dispatch failed","code":"RC5002"}`.

Two things were wrong with that. A malformed request is not a server fault, and `RC5002` is `retryable: false`, so a client honouring the status retried a request that could never succeed. And the message never crossed the wire, so a caller was told a code and nothing else while the instance's log held the sentence naming the field.

**`.input()` body and header validation now throws `RC5065`.** Everything else stays `RC5002`. The split is what lets a transport answer them differently, and it is the reason this is not simply a status-code change.

```
POST /ops/routes/strict/exchanges   {"userId": 42}

before  500  {"error":"dispatch failed","code":"RC5002"}
after   400  {"error":"bad request","code":"RC5065",
              "message":"Body validation failed for route \"strict\": \"userId\": Invalid input: expected string, received number"}
```

`craft exec` renders that message as it stands, so a rejected dispatch now names the field and the rule instead of a code:

```
$ craft exec strict
Body validation failed for route "strict": "userId": Invalid input: expected string, received undefined
```

**The message crosses the wire here and nowhere else.** A route failure is still `500` carrying only its code, because `rcError` messages interpolate causes and adapter failures carry hostnames, file paths and upstream response text. Input validation runs at filter chain position #4, before any step of the pipeline, so the only thing its message can describe is the payload the caller just sent and the schema it did not satisfy. An `.output()` violation, which is the instance failing its own contract, stays a `500` with no message.

**Migrating.** A route-scope `.error()` matching `rc === "RC5002"` to recover a bad payload matches `"RC5065"` now; one matching it to catch an output or `validate()` failure is unchanged. Nothing else moves: the failure is raised at the same chain position, is routable through `.error()` the same way, and carries the same `retryable: false`.
