---
"@routecraft/cli": patch
---

`LOG_LEVEL` and `LOG_FILE` set in an env file now reach the logger. `run` and `start` loaded `.env.<profile>`, a profile's `env:`, and the file `--env` names only after core had built its logger, so log settings there were ignored; only a plain `.env` appeared to work, because Bun loads it at process start. The selected environment is now loaded before core, and `--log-level` / `--log-file` still beat it.

A log file the logger cannot open for appending now stops the command with exit code 2 and a message naming the path and where it came from: `--log-file`, `LOG_FILE`, `CRAFT_LOG_FILE`, or a `craft.log.js` / `craft.log.cjs` file. Before, the command ran on and its logs went to a file of the same name in the system temporary directory, where nobody looked for them.
