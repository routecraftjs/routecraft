---
"@routecraft/routecraft": patch
---

A `.validate()` step whose validator never returns, because every path throws, carries a `never` body again, as it did before validators could refuse. Since the refusal change it carried the body from before the step, so a `.choice<T>()` branch ending in such a validator no longer fit `T` and failed to type-check.
