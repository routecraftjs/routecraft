---
"@routecraft/ai": patch
---

The default MCP server icons (#733) offer a 96x96 PNG alongside the SVG for each theme, and every entry declares `sizes`. A client that renders icons must support PNG and only ought to support SVG, and may refuse SVG deliberately because SVG can carry script, so the previous SVG-only default was one a conforming client could ignore and render no Routecraft mark at all. Inheritance is unchanged: a tool takes the server icons unless it sets its own, and `icons: []` still opts out. Because every inheriting tool carries the set, the default grows from 772 B to 3840 B, and a 28-tool server's `tools/list` from 21.9 KB to 108.8 KB of icon bytes; `icons: []` remains the way out.
