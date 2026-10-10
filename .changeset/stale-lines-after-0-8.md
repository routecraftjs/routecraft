---
"@routecraft/routecraft": patch
"@routecraft/ai": patch
---

Three JSDoc lines caught up with 0.8: `route:exchange:expired` no longer says the sweeper is yet to land, the step-scope `.cache()` default is described as the application's own provider rather than a process-wide one, and `acpPlugin()` no longer tells you to list it after `agentPlugin()`, because the kernel binds agent contributions before the plugins that require them.
