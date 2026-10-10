---
"@routecraft/routecraft": minor
"@routecraft/ai": patch
---

A delivery claim on a deferral is renewed while the re-ask runs and carries an identity that fences every write made under it (#636).

The sweeper claims an expiring record and drives the re-ask through the route's error channel; when the re-ask outlived the 60 minute `expiryLease`, the claim lapsed, the next pass reclaimed the record, and the recipient heard the re-ask twice. The kernel now renews the claim on a heartbeat (three per lease) while the `.error()` handler runs, so only a process that dies mid-delivery spends the lease, and `expiryLease` no longer needs to be longer than the slowest handler.

**Breaking for a custom `DeferralStore`.** Renewal alone leaves an ABA window: a claimant that outlived its lease comes back to a record that is waiting and claimed exactly as it left it, under somebody else's claim. The contract therefore gives every claim an identity and fences renewal and both terminal transitions on it:

- `Deferral.claimedAt` is `Deferral.claim: { id, at, renewedAt }`. `id` is a `DeferralClaimId` (a branded string) minted by the store and distinct for every claim ever taken on a record; `at` never moves; `renewedAt` is what `releaseClaims(before)` compares.
- `claimExpiry(id, at)` returns a `DeferralClaimResult`, which carries the `claim` the caller holds when it won. `claimResultOf(result)` builds one from the plain compare-and-swap result, as both shipped backends do.
- `renewClaim(id, claimId, at)` is new: it moves `renewedAt` and wins only while `claimId` names the live claim on a waiting record.
- `markExpired(id, claimId)` and `markDenied(id, claimId, reason?)` take the claim's id and lose when it is not the live one, so a stale holder can neither settle nor extend the delivery that replaced it.
- The fence compares the identity alone, never the whole claim: a holder's copy of the claim is stale after its first renewal. `claimedBy(record, claimId)` is exported beside `resumable` and `claimed` as the compare the fenced methods make.
- A configured store missing any member of this contract (`renewClaim` on a 0.7 store, typically) is refused when the deferral plugin binds, with `RC5066` naming the member. `list` stays optional: only `GET /ops/deferrals` reads it.

`expiryLease` is refused with `RC5003` above about 74.5 days, where a third of the lease no longer fits a timer and the heartbeat would fire every millisecond. Renewal and release compare wall clocks across processes, so processes sharing a store must agree on the time to well within a third of the lease.

The shipped SQLite backend migrates to schema version 3 on open, giving any claim a 0.7 build left outstanding an identity so the lease releases it as before. A claim a 0.7 process writes into a file already migrated (one still holding it open through a rolling deploy) reads back with an identity no holder can present and is released by the lease from its claim time. Running 0.7 and 0.8 against one SQLite file is still unsupported, because 0.7 does not honour the fence.

`@routecraft/ai` settles a session's released deferral with the id of the claim it won; no public change.
