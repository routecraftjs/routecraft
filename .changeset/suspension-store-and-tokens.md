---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
---

Suspension store, records, and signed resume tokens (#549, slice 1 of #417).

The persistence and identity layer for parked exchanges. No DSL and no executor changes yet: `.suspend()` and `.resume()` arrive in #550, and TTL plus the expiry sweeper in #551. This slice ships the foundation those build on, in core rather than in `@routecraft/ai`, because the store is shared by plain capabilities, human approvals, and the agent tier alike.

**The record and the contract.** `Suspension` is a parked exchange plus everything needed to revive it: route, position, continuation hash, serialized exchange, expected-result schema, action fingerprint, status, and the resume receipt. `stepState` is one opaque slot the store never interprets, which is what lets the agent tier share this store instead of growing a second one. `SuspensionStore` is async throughout and its state transitions are compare-and-swap rather than read-then-write, so a resume racing the sweeper has exactly one winner and multi-node coordination stays addable later.

**Two backends, one contract suite.** `MemorySuspensionStore` for tests and ephemeral use; `SqliteSuspensionStore` as the durable default. The sqlite backend runs on a per-runtime driver split: `bun:sqlite` under Bun, `better-sqlite3` as a new optional peer under Node via `loadOptionalPeer` (`RC5017` with an install hint). `node:sqlite` is deferred; the version matrix behind that call and its graduation condition are recorded in the driver's JSDoc. Both backends pass the same contract suite, and the sqlite one passes it under Bun and Node.

**Signed resume tokens.** HMAC-SHA256, base64url, mintable before the suspending step runs so a notification step can send a working resume link. The signing secret is required configuration, read from `ROUTECRAFT_SUSPENSION_SECRET` or `suspension: { secret }`, and its absence is a build-time `RC5040` rather than a surprise on the first suspend. At least 32 bytes are required, because a token holder can guess the secret offline without limit. It is never generated into the store. `testContext()`, `NODE_ENV=development` and `NODE_ENV=test` mint an ephemeral in-memory key.

**Continuation hashing.** `continuationHash` covers steps `N+1` to the end plus the `expect` schema, not the whole pipeline, so a deploy that touches code before the suspend point does not invalidate approvals in flight while a change to what the approval authorizes still does. A step contributes its inline lambdas and its adapter's options, so repointing a destination after the suspend point (`http({ url: bankA })` to `bankB`) invalidates a parked approval rather than resuming it into a payment to someone else. It covers step definitions only, never the behaviour of what the tail calls. `actionFingerprint` binds an approval to the exact operation it authorized.

**Serialization is a security boundary.** `serializeExchange` refuses anything but plain JSON data with `RC5042`, naming the path that failed, which is what keeps live resolvers out of the store; `Date` round-trips faithfully through a reserved envelope that body data cannot forge. Symbol-keyed properties are refused rather than silently dropped, and `__proto__` is written without going through the inherited setter, so a field named that survives the round trip instead of vanishing. Values carrying the reserved `Secret` brand are refused ahead of #526. A rehydrated principal is marked restored rather than authentic (#355), so `authorize()` rejects it with the new `RC5043` instead of trusting a shape read off disk.

New config key `suspension`, new store key `SUSPENSION_RUNTIME`, new error codes `RC5040` to `RC5044`, and new exports `markRestored` / `isRestored`. `SuspensionStore` carries a `purgeSettled(before)` retention method so a long-running process does not accumulate every exchange that ever suspended; the sweeper wires it up in the lifecycle slice.
