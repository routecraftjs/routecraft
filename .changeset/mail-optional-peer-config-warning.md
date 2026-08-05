---
"@routecraft/routecraft": patch
---

Route every mail adapter driver import (`imapflow`, `nodemailer`, `mailparser`) through `loadOptionalPeer`, so a missing optional peer surfaces as `RC5017` with an install hint instead of a raw module-not-found error, and warn at context construction when a `defineConfig` key has no registered config applier (a typo like `htttp`, or an applier whose registering module never loaded, was previously a silent no-op). A new contract test asserts no bare external dynamic import exists in core outside `loadOptionalPeer`.
