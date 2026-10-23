---
"@routecraft/routecraft": minor
---

Raw bytes on a deferred exchange are persisted and revived. A `Buffer` or a plain `Uint8Array` in the body or headers (a mail attachment's `content`, an HTTP binary body, an agent's file part) travels through the deferral store as a tagged base64 envelope, the way a `Date` already does, and comes back as the same kind of value holding the same bytes. Until now the store refused it with `RC5042`, so a mail exchange with attachments and an agent prompted with a binary part could not defer, and a deferred agent thread holding one could not be compacted with `replaceDeferredThread`. A subclass, a typed array of another element type, a byte array carrying a symbol-keyed property, and a body that forges an envelope key are still refused at defer time; a stored envelope that is not base64 is refused at resume rather than revived truncated.
