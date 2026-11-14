---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/testing": minor
"@routecraft/cli": patch
---

Events carry ids, and bodies only on request.

**Breaking.** No event hands a subscriber an exchange. `details.exchange` is removed from `route:exchange:completed`, `:failed`, `:dropped`, `context:error`, `route:error`, `route:error:caught`, `route:step:error`, `route:stopping` and `route:stopped`; the error events carry `exchangeId` and `correlationId` in its place, and the stop events, which never set it, carry nothing. The `_snapshot` envelope, on these and on the agent tool, agent block and `plugin:mcp:tool:called` events, reaches only a subscription made with `{ snapshots: true }`, so its type is optional.

- `ctx.on`, `ctx.once`, `ContextBuilder.on` / `.once`, `testContext().on` / `.once` and a plugin's `c.observe` take `{ snapshots: true }` as a third argument; the `on` and `once` config keys take `{ handler, snapshots: true }`.
- `_snapshot.exchange` is a frozen copy `{ id, headers, body }`, built once per emit and only when an opted-in subscription reads it. `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` and every header a plugin lists in the new `secretHeaders` descriptor member are left out, in any letter case and at every depth of a header, so the wire headers under `routecraft.http.rawHeaders` lose theirs; the HTTP plugin lists `routecraft.http.cookies`. The principal header is reduced to its reference, and a value branded a `Secret` is withheld. A value that cannot be cloned is `{ unserializable: true }`.
- The opt-in holds for the subscription it was made with: the same handler subscribed to another event without it receives no envelope there.
- `route:exchange:started`, `:completed`, `:failed` and `:dropped` carry `principal`, a `PrincipalRef`.
- `emit(event, details, exchange?)` on the context and on a plugin's context: the exchange given beside the details is what the snapshot is copied from.
- The telemetry plugin subscribes with snapshots only when `captureSnapshots` is on, and its event table holds no exchange copy: the exchange is stored once, in `exchange_snapshots`. The ACP mount and the agent session runtime subscribe with snapshots.
- The application logs at start who subscribed with snapshots: each plugin by id, and `application` for the rest.
- An `event()` route reacting to an error event continues the failed exchange's journey, from the `correlationId` those events now carry.
- New exports: `ExchangeSnapshot`, `ExchangeSnapshotEnvelope`, `SubscribeOptions`.

See section 20 of the 0.7 to 0.8 migration guide.
