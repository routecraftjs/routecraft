---
"@routecraft/cli": patch
---

Raise the runtime dependency floors for `@opentelemetry/sdk-trace-base` to `^2.10.0`, `fast-xml-parser` to `^5.10.1`, `jose` to `^6.2.8` and `mailparser` to `^3.9.15`. The `imapflow` floor deliberately stays at `^1.4.7`: 1.6.6 is inside the dependency cooldown window and the mail source's reconnect behaviour changed in this same release, so consumers are not forced onto it.
