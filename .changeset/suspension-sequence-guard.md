---
"@routecraft/routecraft": patch
---

The suspension park counter refuses corruption instead of resetting (#635).

The framework-owned `routecraft.suspension.sequence` header used to tolerate any malformed value by resetting the counter to 0, silently re-deriving a suspension id an earlier park of the same exchange already used. Resume tokens sign the id, so a reused id would let an old unspent link verify against a new park. A malformed or exhausted counter value now refuses with the new `RC5057`, with the two cases distinguishable in the message; a missing header still reads as zero, since an exchange that has never parked legitimately carries none. The refusal surfaces only on suspension surfaces (`ex.suspension`, or the park itself), so routes that never touch suspension are unaffected by a mangled header.
