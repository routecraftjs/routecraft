---
"@routecraft/cli": patch
---

`craft start --once` names `shutdown.timeout` when a forced shutdown tells you to raise the drain deadline. It named the 0.6 `shutdown.timeoutMs`, which 0.7 refuses with `RC5003`.
