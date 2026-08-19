---
"@routecraft/routecraft": patch
---

An IMAP pool drained mid-connect no longer throws during teardown.

The pool reserves a slot before its connect resolves, since the reservation is
what bounds the pool size. `drain()` dereferenced every slot's client
unconditionally, so a shutdown that began while a connection was still being
established threw `null is not an object`. That is the ordinary shape of a
shutdown during startup, and the thrown teardown masked whatever had actually
failed the boot.

Drain now skips a slot that holds no client yet, and an acquire whose connect
lands after the drain logs its own connection out rather than leaving a socket
open with nothing referencing it.
