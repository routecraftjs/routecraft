---
"@routecraft/routecraft": patch
---

The mail adapter's optional `mailauth` peer now accepts 8.x from 8.0.6 onward. Use it for `verify: 'strict'`: every 7.x release pins a `joi` with a denial-of-service advisory (CVE-2026-118772), and 8.0.6 is the first release that pins a fixed one. The adapter's behaviour is unchanged.
