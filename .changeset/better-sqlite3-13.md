---
"@routecraft/routecraft": patch
---

The deferral and session stores accept `better-sqlite3` 12 and 13 under Node. The peer range was `^11.0.0`, and 11 ships no prebuilt binary for Node 24, so installing it there compiled the addon from source and failed on a machine without a C++ toolchain. 13 carries Node-API binaries inside the package and installs without a build step on Node 22 and later; 11 and 12 keep working.
