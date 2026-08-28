---
"@routecraft/routecraft": patch
---

The stream expiry check now applies the clock tolerance that admitted the credential.

`isPrincipalExpired` documents itself as the single source of the expiry boundary, and the checkpoint that closes a stream when its credential lapses called it without the tolerance the admitting verification had applied. So a client inside the tolerance window looped: admission admitted it, the stream armed, found the credential expired by its own stricter boundary, and closed, and the client reconnected into the same pair of answers.

The resolved tolerance now rides on the admit verdict, beside the principal and the credential it already carried, so anything re-checking that credential inherits the boundary by construction rather than by remembering to pass an argument. Resolving it a second time from config at each consumer would reproduce the same class of bug the moment the two resolutions drifted.

The timer sleeps to the deadline the tolerance moves rather than to `exp`, since waking inside the window would find the credential good and re-arm on the fifty millisecond floor for the rest of it.
