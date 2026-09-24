---
"@routecraft/cli": patch
---

`craft run` runs a file that sits outside any project. In a directory with no `node_modules`, Bun switched the whole process to auto-install, so the file's import of `@routecraft/routecraft`, and the CLI's own, resolved into Bun's download cache: a `cron()` file could not find `croner`, and even a file with no adapter dependency crashed in the logger's worker. Where core is not installed, the CLI now starts itself again with auto-install off and looks up packages in the working directory's `node_modules` first and its own install after. A lone file runs on the core that ships with the CLI, and a package an adapter asks for is found next to the file (`bun add croner`) or next to a global CLI (`bun add -g croner`). A project with core installed behaves as before.
