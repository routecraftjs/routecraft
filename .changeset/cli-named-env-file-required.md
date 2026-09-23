---
"@routecraft/cli": patch
---

A missing or unreadable env file named with `--env <path>`, or by a profile's `env: "<file>"`, stops the command with exit code `2` and the path, instead of being skipped with an info-level note hidden at the default log level. The conventional `.env` / `.env.<profile>` / `.env.local` cascade stays optional.
