---
"@routecraft/routecraft": patch
---

`mail({ action: "append" })` keeps the Bcc header on the stored message, so a draft's Bcc recipients survive the append.
