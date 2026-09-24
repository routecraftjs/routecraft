---
"@routecraft/ai": patch
---

A missing or non-HTTPS `resource.url` on the MCP HTTP transport outside `development` and `test`, or one that is not an absolute URL, fails with `RC5003` and a suggestion naming the fix, instead of a bare `TypeError`. The stdio transport, which ignores `resource`, no longer validates it. The `McpResourceOptions.url` and `resource` documentation no longer promises a default that production does not apply.
