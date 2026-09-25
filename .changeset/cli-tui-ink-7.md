---
"@routecraft/cli": patch
---

`craft tui` now runs on Ink 7 and React 19. Nothing changes in how it looks or which keys it takes. The CLI used to install its own React 18, so a project on React 19 carried both majors; it now depends on React `^19.2.0` and shares a project's React 19.2 or later.
