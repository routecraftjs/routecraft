---
"@routecraft/ai": minor
---

`mcpPlugin({ clients })` now rejects a client name containing `__` with RC5003 at startup. That name becomes the server segment of the `mcp__<server>__<tool>` tool name agents see, and resolution splits it at the first separator after the prefix, so a client called `a__b` exposing `c` generated `mcp__a__b__c` and read back as server `a`, tool `b__c`. Previously nothing failed at startup and every tool on such a client was dropped at dispatch with only a warning, so a typo cost an agent its whole toolset with no signal until something asked for it. A single underscore is unaffected (`my_company_api`), and because only the server half is constrained, a remote may keep using `__` in its own tool names.
