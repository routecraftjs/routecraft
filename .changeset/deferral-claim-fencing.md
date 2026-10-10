---
"@routecraft/routecraft": minor
"@routecraft/ai": patch
---

A delivery claim on a deferral is renewed while the re-ask runs and carries an identity that fences every write made under it (#636).

The sweeper claims an expiring record and drives the re-ask through the route's error channel; when the re-ask outlived the 60 minute `expiryLease`, the claim lapsed, the next pass reclaimed the record, and the recipient heard the re-ask twice. The kernel now renews the claim on a heartbeat (three per lease) while the `.error()` handler runs, so only a process that dies mid-delivery spends the lease, and `expiryLease` no longer needs to be longer than the slowest handler.

**Breaking for a custom `DeferralStore`.** Renewal alone leaves an ABA window: a claimant that outlived its lease comes back to a record that is waiting and claimed exactly as it left it, under somebody else's claim. The contract therefore gives every claim an identity and fences renewal and both terminal transitions on it:

- `Deferral.claimedAt` is `Deferral.claim: { id, at, renewedAt }`. `id` is minted by the store and distinct for every claim ever taken on a record; `at` never moves; `renewedAt` is what `releaseClaims(before)` compares.
- `claimExpiry(id, at)` returns a `DeferralClaimResult`, which carries the `claim` the caller holds when it won.
- `renewClaim(id, claim, at)` is new: it moves `renewedAt` and wins only while `claim` is the live claim on a waiting record.
- `markExpired(id, claim)` and `markDenied(id, claim, reason?)` take the claim and lose when it is not the live one, so a stale holder can neither settle nor extend the delivery that replaced it.
- `claimedBy(record, claim)` is exported beside `resumable` and `claimed` as the compare the fenced methods make.

The shipped SQLite backend migrates to schema version 3 on open, giving any claim a 0.7 build left outstanding an identity so the lease releases it as before.

`@routecraft/ai` settles a session's released deferral with the claim it won; no public change.
