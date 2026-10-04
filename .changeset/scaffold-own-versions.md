---
"create-routecraft": patch
---

The scaffolder pins each `@routecraft/*` package at that package's own version instead of its own. Only the core train shares one number; `@routecraft/ai` and `@routecraft/os` version independently, so 0.7.1 asked for `@routecraft/os@^0.7.1`, a release that does not exist, and every scaffold of an example using `@routecraft/os` (craft-harness among them) failed to install. The versions are captured when the scaffolder is built, so they are the ones it was released with.
