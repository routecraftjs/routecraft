---
"@routecraft/routecraft": patch
---

Fix the published bundles silently dropping every core config applier (`mail`, `carddav`, `direct`, `cron`, `http`, `telemetry`).

The package's `sideEffects` allowlist named only the dist entry points, which marked the `src` config modules as pure, so esbuild pruned their side-effect imports out of the bundle during the package's own build: `defineConfig({ mail: { accounts } })` typechecked but was never applied at runtime, and `mail("INBOX", { account: "default" })` failed with "IMAP host is required". The field is removed (dist ships only the entry bundles, so it granted consumers nothing), and the build now runs a post-build guard that imports both bundles and asserts every `registerConfigApplier` key found in the source is live in the registry.
