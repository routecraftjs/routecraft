---
"@routecraft/cli": patch
---

`craft acp`, `craft exec` and `craft ops` take `--project <dir>`, which reads the profile from that project's `.routecraft/settings.yaml` instead of the working directory's. An editor starts `craft acp` from whichever project it has open, so a profile kept in the harness's own settings file was found only from the harness's window; naming the project makes one editor entry work from every window without copying its token into the global settings file. A path that is not a directory exits `2` naming it.
