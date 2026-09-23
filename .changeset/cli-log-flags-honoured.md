---
"@routecraft/cli": patch
---

`--log-level` and `--log-file` take effect again. In 0.7.0 the CLI loaded core for its Bun version check before any command had applied the logging flags, which built the logger from the defaults: both flags were ignored, and `--log-file` left every log line on stdout, where it corrupts an MCP stdio transport. The version check now runs after the flags are applied.
