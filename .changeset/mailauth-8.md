---
"@routecraft/routecraft": minor
---

The mail adapter's optional `mailauth` peer now requires 8.x from 8.0.6 onward. Every 4.x, 5.x and 7.x release pins a `joi` with a denial-of-service advisory (CVE-2026-118772), and 8.0.6 is the first release that pins a fixed one. A project using `verify: 'strict'` upgrades with `bun add mailauth@^8.0.6`; the adapter's behaviour is unchanged.
