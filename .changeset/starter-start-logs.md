---
"create-routecraft": patch
---

A scaffolded project's `start` script shows its sample greeting again. 0.7.0 moved the script to `craft start` at the default `warn` level, so the greeting the README promises, logged at `info`, never appeared. The script is now `craft start --log-level info`, as it was in 0.6.
