---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
"@routecraft/eslint-plugin-routecraft": patch
---

Three gaps in the defer contract are closed.

**Breaking: a deferral record carries its format.** `Deferral.format` is an integer the kernel writes, and a resume refuses a record in any other format, older or newer, with `RC5048` ("record format changed") and re-asks through the deferred route's `.error()`. A custom `DeferralStore` persists the field as given; the shipped SQLite store moves to schema version 4 on open, and a row written before the column reads as format `0`. The store conformance suite checks the round trip.

**A deferral parks the exchange it was raised for, once.** The signal `ctx.defer()` rejects with could be kept by a step and thrown on a later exchange, parking that exchange at a site it never reached. It is now `RC5032`.

**Only `.log()` is left out of the step digest.** The exemption was a registered symbol any step could carry, which let a step change what runs after an approval without the digest moving. It is now held by the kernel and set by the route builder alone.

`restrict-continuation-minting` also flags `lookupOf(exchange, CONTINUATIONS).signer.mint()`.
