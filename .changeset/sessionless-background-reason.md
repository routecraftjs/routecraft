---
"@routecraft/ai": patch
---

An agent dispatched without a session that holds a direct tool over a route that can park is refused with the reason: the route can park, so no flag makes the tool synchronous, and the fix is a session on the dispatch or the tool off that agent's list. The message used to say the tool was declared `background: true` and to drop the flag, which nobody had written and which is refused on such a route. A tool that is background because it was declared so still gets that advice.
