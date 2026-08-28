---
"@routecraft/os": minor
---

`shell({ timeout })` and `shellPlugin({ timeout })` now take a `Duration`.

Both were documented as "milliseconds before the command is killed" and typed as a
bare `number`, which left `@routecraft/os` outside the framework-wide convention
that every authored time option accepts `number | "30s"`.

This is a widening, not a rename: the option was already correctly named, so every
existing numeric value keeps working unchanged.

```ts
shellPlugin({ timeout: 30_000 })  // still fine
shellPlugin({ timeout: "30s" })   // now also fine
```
