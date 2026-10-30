---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Disabled is not down: agent tool references and health indicators follow enablement instead of failing.

- An agent's `Direct(<id>)` reference, in code or in `.md` frontmatter, and a `directTool(<id>)` fn over a route held back by `.enabled()` are left out of the agent's tools with one warning naming the reference, the route and the reason, and return once the route is enabled. A `directTool` fn over a disabled route no longer fails `context.start()`. An id no route declares still throws `RC5003`.
- `mcpPlugin({ clients })` entries accept `enabled` (`true`, a reason string, `false`, or a function returning one), evaluated once at bind. A disabled client is never connected; a proxy route over it serves nothing; a call to it is refused with the reason.
- An `MCP(<client>)` or `MCP(<client>:<tool>)` reference to a disabled client, to a configured client that has listed no tools yet, or to a tool a live client does not list is left out with one warning per registry version instead of throwing `RC5003`. A client id matching no configuration still throws. Code that relied on the throw to fail a turn now reads the warning.
- An indicator bound to a route with `route` follows the route's enablement: while the route is disabled it reports `inactive` with the route's reason and never goes stale. `defineIndicator` accepts `enabled` with the same shape; a disabled indicator ignores `up()` and `down()`. Coming back on restarts its staleness window.
- New export `evaluateEnablementOnce` and type `EnablementDeclaration` for one-shot enablement declarations.
