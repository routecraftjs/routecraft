---
"@routecraft/routecraft": patch
"@routecraft/os": patch
---

The optional peers accept their new majors beside the old ones: `croner` 10 or 11, `imapflow` 1 or 2, and `execa` 9 or 10. Nothing changes for an application that stays on the older major. `imapflow` 2 needs Node 20 and `execa` 10 needs Node 22, both inside what Routecraft already requires.

`mail()` no longer hands a route a string as `MailMessage.date` when a message's `Date` header cannot be parsed: the date falls back to the time the message was read, as it already did for a message with no `Date` header.
