---
"@routecraft/routecraft": patch
---

A function `path` on `file()` or `directory()` selects an overload without the source role, so `.from(file({ path: (ex) => ... }))` and `.from(directory({ path: (ex) => ... }))` are compile errors instead of a refusal when the route starts. The `.to()` and `.enrich()` forms are unchanged, and options typed as `FileOptions` or `DirectoryOptions` keep the combined adapter and its runtime check.
