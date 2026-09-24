---
"@routecraft/routecraft": patch
---

`defineConfig` rejects a key `CraftConfig` does not declare, at any depth. Its generic parameter checked an unknown key only when it was the sole key at its level, so a misspelled or 0.6 key beside a valid one (`http: { host, port, auth }`, `shutdown: { timeout, timeoutMs }`) compiled against 0.7 and was ignored or failed at boot. It is now a compile error, the same one `const craftConfig: CraftConfig = {...}` reports; the [0.6 to 0.7 migration guide](https://routecraft.dev/docs/migrating/0.6-to-0.7) lists where each removed key went. The helper now returns `CraftConfig` rather than the literal type of its argument, so code that reads a key off the returned value treats it as optional, as it already is on `CraftConfig`.

Shipped as a patch by decision, although both changes can stop code compiling: neither changes runtime behaviour, and the keys now rejected were already ignored or refused at boot.
