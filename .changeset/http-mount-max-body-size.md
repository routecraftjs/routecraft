---
"@routecraft/routecraft": minor
---

A mount can set its own request body cap. `http: { mounts: { uploads: { path, maxBodySize } } }` replaces the plugin's `maxBodySize` for that mount alone, so an upload path can take 25 MB while every other mount, the public ones included, stays at the plugin's cap. It is validated like the plugin's: a positive integer, never zero or `Infinity`.
