---
"@routecraft/routecraft": patch
---

The SQLite stores (deferral, agent sessions, telemetry) accept `better-sqlite3` 12 and 13 under Node. The peer range was `^11.0.0`, and 11 ships no prebuilt binary for Node 24, so installing it there compiled the addon from source and failed on a machine without a C++ toolchain. 13 carries Node-API binaries inside the package for Linux (glibc and musl), macOS and Windows on x64 and arm64 and has no install step, so it needs Node 22.14 or later and one of those targets; elsewhere, stay on 12. On older Node, 13 is refused with `RC5017` naming the fix, instead of crashing the process when the first database opens. 11 and 12 keep working.
