---
"@routecraft/routecraft": patch
---

`defineConfig` rejects a key `CraftConfig` does not declare, at any depth. Its generic parameter skipped TypeScript's excess-property check, so a config still written for 0.6 (for example `http: { host, port, auth }`, or `shutdown.timeoutMs`) or a misspelled key compiled against 0.7 and failed only at boot. It is now a compile error, the same one `const craftConfig: CraftConfig = {...}` reports; the [0.6 to 0.7 migration guide](https://routecraft.dev/docs/migrating/0.6-to-0.7) lists where each removed key went. The helper now returns `CraftConfig` rather than the literal type of its argument, so code that reads a key off the returned value treats it as optional, as it already is on `CraftConfig`.
