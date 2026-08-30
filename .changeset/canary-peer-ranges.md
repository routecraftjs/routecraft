---
"@routecraft/ai": patch
"@routecraft/os": patch
"@routecraft/testing": patch
---

Peer ranges on `@routecraft/routecraft` admit the canaries of the line they
belong to.

`@routecraft/ai` and `@routecraft/testing` declared `>=0.7.0 <1.0.0` and
`@routecraft/os` declared `>=0.6.0 <1.0.0`. A prerelease satisfies a range only
when some comparator carries a prerelease on the same `major.minor.patch`, so
none of them admitted `0.7.0-canary-*`. Changesets rewrites a peer that is out
of range to the exact version being published, which is only coherent inside
the batch that produced it: `ai` and `os` publish in their own batches, so
their pins pointed at a core canary that had already moved, and a downstream
install of both at the `canary` tag resolved a second copy of core whose
`Exchange` and `StoreRegistry` types are structurally distinct from the first.

All three now read `>=0.7.0-0 <1.0.0`.

The lower bound has to move when the line moves to a new minor, because `-0`
does not reach forward: `>=0.7.0-0` refuses `0.8.0-canary-1`. A contract test
now fails the gate when a declared range no longer admits the version that
governs it, naming the manifest, the range and the version it refuses, so the
maintenance is caught here rather than downstream.
