---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
"@routecraft/ai": minor
"@routecraft/cli": minor
---

The names only the `@routecraft/*` packages use have moved off the main entry to `@routecraft/routecraft/internal`, a subpath with no compatibility promise that a third party must not import.

Breaking: `@routecraft/routecraft` no longer exports `RC_ADAPTER_OVERRIDES`, `SOURCE_FIXTURE`, `AdapterOverride`, `AdapterSendCall`, `AdapterSourceCall`, `SendOverrideHandler`, `SourceFixture`, `SourceOverrideBehavior`, `clipText`, `rejectStaleOptions`, `isDevelopmentRuntime`, `parseRuntimeVersion`, `compareRuntimeVersion` or `RuntimeVersion`. All were tagged `@internal`. To override an adapter in a test, use `mockAdapter()` and `testContext().override()` from `@routecraft/testing`, which are unchanged; `isSourceFixture` and `SourceMessage` stay on the main entry.
