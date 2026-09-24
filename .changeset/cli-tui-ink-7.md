---
"@routecraft/cli": patch
---

`craft tui` now runs on Ink 7 and React 19. Nothing changes in how it looks or which keys it takes. The CLI previously installed React 18, the only React 18 in the workspace, so a project with the CLI carried two React majors. It now shares the React 19 line the rest of the stack uses.
