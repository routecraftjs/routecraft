---
"@routecraft/routecraft": minor
---

Raw bytes on a deferred exchange are persisted and revived. A `Buffer` or a plain `Uint8Array` in the body or headers (a mail attachment's `content`, a file read, an HTTP binary body) travels through the deferral store as a base64 envelope, `BYTES_TAG`, the way a `Date` travels through `DATE_TAG`, and comes back as a `Buffer` holding the same bytes. Until now the store refused it with `RC5042`, so a mail exchange with attachments could not defer. A subclass, a typed array of another element type, a byte array carrying extra properties, and a body that forges the envelope key are still refused at defer time; a stored envelope that is not base64 is refused at resume rather than revived truncated.
