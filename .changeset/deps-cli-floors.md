---
"@routecraft/cli": patch
---

Raise the runtime dependency floors for `@opentelemetry/sdk-trace-base`, `fast-xml-parser`, `jose` and `mailparser` to their newest patch and minor releases. The `imapflow` floor deliberately stays at `^1.4.7`: 1.6.6 is inside the dependency cooldown window and the mail source's reconnect behaviour changed in this same release, so consumers are not forced onto it.
