---
"@routecraft/ai": minor
---

A route's MCP tool can ship a view that hosts supporting the MCP Apps extension, such as Claude, render instead of showing the result as JSON. Pass `mcp({ ui: { html, csp?, prefersBorder? } })` on a route that declares `.output()`; `html` is a string or a loader such as `fromFile('./view.html')`. The tool advertises `_meta.ui.resourceUri` (`ui://<server name>/<route id>`) on `tools/list`, and the server now declares the `resources` capability and serves each view through `resources/list` and `resources/read` as `text/html;profile=mcp-app`, behind the same auth and `tools` filter as the tools. A view that fails to load answers a generic error and emits `plugin:mcp:ui:failed`. Tools without `ui` are unchanged. `fromFile()` now returns `() => Promise<string>` instead of a four-argument block resolver, which it already ignored, so it also fits `ui.html`.
