---
"@routecraft/ai": patch
---

A missing or non-HTTPS `resource.url` on the MCP HTTP transport outside `development` and `test` fails with `RC5003` and a suggestion naming the fix, instead of a bare `TypeError`. The `McpResourceOptions.url` and `resource` documentation no longer promises a default that production does not apply.
