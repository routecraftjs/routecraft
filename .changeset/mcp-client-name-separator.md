---
"@routecraft/ai": minor
---

`mcpPlugin({ clients })` now rejects a client name that is empty, contains `__`, or ends in `_`, throwing RC5003 at startup.

The key becomes the server segment of the `mcp__<server>__<tool>` tool name agents see, and resolution splits that at the first separator after the prefix. A client called `a__b` exposing `c` generated `mcp__a__b__c`, which read back as server `a`, tool `b__c`. A client ending in `_` is worse than unresolvable: `foo_` exposing `bar` composes `mcp__foo___bar`, the same name `foo` exposing `_bar` composes, and the resolved tool map is keyed by that name with later-wins, so one client silently shadowed the other and a model's call reached the wrong tool.

Previously nothing failed at startup and every tool on such a client was dropped at dispatch with only a warning, so a typo cost an agent its whole toolset with no signal until something asked for it.

**Breaking.** A context whose client key has one of these shapes built successfully before and now throws at `mcpPlugin()`. The rejection is namespace-wide: `mcpPlugin()` validates its options at construction, before it can know whether an agent will join the same context, so it applies even to a context that only uses `.to(mcp("name:tool"))` or `proxy`, where the composed wire name never appears. Renaming a client means updating the key, every `mcp("name:tool")` ref, and every `proxy` ref that names it. The error suggests a concrete replacement name, and a test pins that every suggestion it makes is one the validator accepts.

A single underscore inside the name is unaffected (`my_company_api`), and because only the server half is constrained, a remote may keep using `__` in its own tool names.
