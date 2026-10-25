---
"@routecraft/routecraft": patch
---

A `.validate()` whose validator is typed `never` (it always throws) types the body after it as `never` again, as it did before the step learned to refuse, so a `.choice()` branch that ends in one fits the branches' common type and compiles. The refusal-only case keeps the body type as it was.
