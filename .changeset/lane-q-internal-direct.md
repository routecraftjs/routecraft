---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

`direct({ internal: true })`: a trusting subroutine can close its external doors (#677).

An internal direct source keeps its in-process endpoint, so `direct("id")` enrichers and `forward()` compose against it unchanged, and skips the capability registry: the route is not dispatchable through the ops management API (the listing shows `dispatchable: false`) and not resolvable as an agent `directTool`.

Both external doors refuse by name. Ops dispatch keeps `RC5060` but says the route is declared internal instead of advising a direct source the route already has, and a `directTool` naming an internal route fails `context.start()` with the boundary-route guidance: expose a route carrying `.input()`, `.description()` and `.authorize()`, and point the tool at that.

The default is unchanged: `direct()` routes stay dispatchable, and the option is additive.
