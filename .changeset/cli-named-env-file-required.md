---
"@routecraft/cli": patch
---

A missing or unreadable env file named with `--env <path>`, or by a profile's `env: "<file>"`, stops the command with exit code `2` and the path, instead of being skipped with an info-level note hidden at the default log level. In the conventional `.env` / `.env.<profile>` / `.env.local` cascade a missing file is still skipped, but one that exists and cannot be read stops the command the same way.
