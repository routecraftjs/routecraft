---
"@routecraft/routecraft": patch
---

The deferral counter refuses corruption instead of resetting (#635).

The framework-owned `routecraft.deferral.sequence` header used to tolerate any malformed value by resetting the counter to 0, silently re-deriving a deferral id an earlier deferral of the same exchange already used. Resume tokens sign the id, so a reused id would let an old unspent link verify against a new deferral. A malformed or exhausted counter value now refuses with the new `RC5057`, with the two cases distinguishable in the message; a missing header still reads as zero, since an exchange that has never deferred legitimately carries none. The refusal surfaces only on deferral surfaces (`ex.deferral`, or the deferral itself), so routes that never touch deferral are unaffected by a mangled header.
