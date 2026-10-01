---
"@routecraft/routecraft": patch
---

An `.input()` schema that fails without reporting any issue is no longer answered as the caller's mistake. Its `RC5065` carries no `InputValidationFailure` detail, so the `http()` source and the ops dispatch mount answer 500 and the MCP server the generic failure text, instead of a 400 with an empty issue list. A schema that reports its issues is unchanged.
