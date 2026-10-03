---
"@routecraft/cli": patch
---

`craft acp [dir]` reads the profile from the named project's `.routecraft/settings.yaml`. An editor starts the bridge from whichever project it has open, so a profile kept in the harness's own settings file was not found unless that project was the open one; naming the harness folder makes one editor entry work from every window without copying its token into the global settings file.
