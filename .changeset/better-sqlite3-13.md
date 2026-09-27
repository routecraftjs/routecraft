---
"@routecraft/routecraft": patch
---

The deferral and session stores accept `better-sqlite3` 12 and 13 under Node. The peer range was `^11.0.0`, and 11 ships no prebuilt binary for Node 24, so installing it there compiled the addon from source and failed on a machine without a C++ toolchain. 13 carries Node-API binaries inside the package for Linux (glibc and musl), macOS and Windows on x64 and arm64, so it installs there without a build step on Node 22 and later; other targets still compile. 11 and 12 keep working.
