---
"@routecraft/routecraft": patch
---

`.from()` accepts sources spread in after a leading source, so `.from(direct(), ...extra)` with a plain array no longer fails with TS2556. A helper that builds a shared set of channels can be spread on its own, `.from(...channels())`, when it returns the non-empty tuple type `[SourceLike<unknown>, ...SourceLike<unknown>[]]`. A bare `.from()` and a spread of a plain array on its own stay compile errors, since a route needs at least one source. More than one source without `.input({ body })` still fails with `RC2001` at `.from()`, spread or not. Single-source body inference is unchanged.
