---
"@routecraft/routecraft": patch
---

`verify: 'strict'` on the mail source verifies DKIM and ARC under Bun. A TXT string holds at most 255 bytes, so every real DKIM and ARC key is published as several strings of one record. Bun's `dns.resolveTxt` returns each string as a record of its own, `mailauth` read only the first, and the truncated key failed every signature as an invalid public key, so no message was ever `trust: "verified"`. The lookup of a `_domainkey` name now puts the strings back together on Bun. Any other name keeps its TXT records apart, so SPF at an apex that publishes several records is unaffected, and Node is unchanged.
