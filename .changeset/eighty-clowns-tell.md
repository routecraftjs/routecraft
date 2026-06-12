---
"@routecraft/routecraft": minor
---

`.input({ body: schema })` now retypes the route builder: the schema's inferred output flows into an untyped `.from()` source, so `.from(direct())` after `.input()` is already narrowed and the duplicated `.from<T>()` generic is no longer needed. Typed sources and explicit `.from<T>()` generics still win.
